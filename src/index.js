import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState
} from '@discordjs/voice';
import prism from 'prism-media';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import * as wavEncoder from 'wav-encoder';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const OPENCLAW_ENDPOINT = process.env.OPENCLAW_ENDPOINT || 'http://localhost:8000/respond';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-1';
const TTS_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.TTS_VOICE || 'alloy';
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || '';

const SILENCE_MS = Number(process.env.SILENCE_MS || 800);
const MIN_UTTERANCE_MS = Number(process.env.MIN_UTTERANCE_MS || 600);
const SILENCE_THRESHOLD = Number(process.env.SILENCE_THRESHOLD || 0.01); // RMS threshold 0-1
const PRE_ROLL_MS = Number(process.env.PRE_ROLL_MS || 300);

// Turn-taking: allow user to interrupt bot speech (barge-in)
const BARGE_IN_ENABLED = process.env.BARGE_IN !== '0';
const BARGE_IN_THRESHOLD = Number(process.env.BARGE_IN_THRESHOLD || 0.02);

// STT optimization: send 16kHz mono wav to STT
const STT_SAMPLE_RATE = Number(process.env.STT_SAMPLE_RATE || 16000);
const MAX_UTTERANCE_MS = Number(process.env.MAX_UTTERANCE_MS || 15000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_STT_MAX = Number(process.env.RATE_LIMIT_STT_MAX || 10);
const RATE_LIMIT_TTS_MAX = Number(process.env.RATE_LIMIT_TTS_MAX || 10);

const ALLOWLIST = new Set(['323379312608673803', '381895367861600258']);

if (!DISCORD_TOKEN) {
  throw new Error('DISCORD_TOKEN is required');
}
if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

const connections = new Map();
const rateLimits = new Map();

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  if (VOICE_CHANNEL_ID) {
    autoJoinVoiceChannel(VOICE_CHANNEL_ID).catch((err) => {
      console.error('Auto-join failed', err);
    });
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  // Track changes affecting the bot or allowlisted users.
  const watched = new Set([client.user?.id, ...ALLOWLIST]);
  if (!watched.has(newState.id) && !watched.has(oldState.id)) return;

  const s = (st) => ({
    channelId: st.channelId || null,
    serverMute: Boolean(st.serverMute),
    serverDeaf: Boolean(st.serverDeaf),
    selfMute: Boolean(st.selfMute),
    selfDeaf: Boolean(st.selfDeaf)
  });

  logEvent('voice_state_update', {
    userId: newState.id,
    old: s(oldState),
    now: s(newState)
  });

  // Fallback: if Discord "speaking" events don't fire, start a receiver subscription
  // when allowlisted users are present in our active voice channel.
  try {
    const guildId = newState.guild?.id || oldState.guild?.id;
    if (!guildId) return;
    const state = connections.get(guildId);
    if (!state) return;

    // Only care about allowlisted users.
    const isAllow = ALLOWLIST.has(newState.id) || ALLOWLIST.has(oldState.id);
    if (!isAllow) return;

    // Update standby mode when allowlisted presence changes
    refreshStandby(state);

    // If user joined our connected voice channel, ensure we have an active recording.
    if (!state.standby && newState.channelId && newState.channelId === state.channelId) {
      startRecording(state, newState.id);
    }

    // If user left our connected voice channel, clean up any active recording.
    if (oldState.channelId === state.channelId && newState.channelId !== state.channelId) {
      cleanupRecording(state, oldState.id);
    }
  } catch (err) {
    console.error('voiceStateUpdate handler error', err);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!ALLOWLIST.has(message.author.id)) return;
  const content = message.content.trim();

  if (content === '!join') {
    const voice = message.member?.voice?.channel;
    if (!voice) {
      await message.reply('Join a voice channel first.');
      return;
    }

    const existing = connections.get(message.guild.id);
    if (existing) {
      existing.manualLeave = true;
      existing.connection.destroy();
      connections.delete(message.guild.id);
    }

    const state = await connectToChannel(voice, {
      manualLeave: false
    });

    await message.reply(`Joined ${voice.name}.`);
  }

  if (content === '!leave') {
    const state = connections.get(message.guild.id);
    if (!state) return;
    state.manualLeave = true;
    state.connection.destroy();
    connections.delete(message.guild.id);
    logEvent('voice_leave', {
      guildId: message.guild.id,
      channelId: state.channelId
    });
    await message.reply('Left the channel.');
  }

  // Debug: force TTS playback to validate output path
  if (content.startsWith('!say ')) {
    const state = connections.get(message.guild.id);
    if (!state) {
      await message.reply('Not in voice.');
      return;
    }
    const text = content.slice('!say '.length).trim().slice(0, 200);
    if (!text) return;
    await message.reply('ok');
    await speak(state, text, message.author.id);
  }
});

async function autoJoinVoiceChannel(channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isVoiceBased()) {
    console.error('VOICE_CHANNEL_ID is not a voice channel');
    return;
  }

  await connectToChannel(channel, {
    manualLeave: false,
    autoJoin: true
  });
}

async function connectToChannel(voiceChannel, { manualLeave, autoJoin } = {}) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  player.on('stateChange', (oldState, newState) => {
    logEvent('player_state', {
      old: oldState.status,
      now: newState.status
    });
  });
  player.on('error', (err) => {
    console.error('Audio player error', err);
  });

  const state = {
    connection,
    player,
    recordings: new Map(),
    timers: new Map(),
    guildId: voiceChannel.guild.id,
    channelId: voiceChannel.id,
    manualLeave: Boolean(manualLeave),
    autoJoin: Boolean(autoJoin),
    standby: false,
    currentPlayback: null
  };

  connections.set(voiceChannel.guild.id, state);

  attachConnectionHandlers(state);
  setupReceiver(state, voiceChannel.guild.id, voiceChannel.id);

  logEvent('voice_join', {
    guildId: voiceChannel.guild.id,
    channelId: voiceChannel.id,
    autoJoin: Boolean(autoJoin)
  });

  // Debug: speak on join so we can validate playback (green ring)
  if (process.env.AUTO_SPEAK_ON_JOIN === '1') {
    speak(state, 'Audio test. If you can hear this, TTS playback works.', 'system').catch((err) => {
      console.error('AUTO_SPEAK_ON_JOIN failed', err);
    });
  }

  // Prime subscriptions for allowlisted users already in channel
  primeSubscriptions(state, voiceChannel).catch((err) => {
    console.error('primeSubscriptions error', err);
  });

  // Initialize standby based on current channel membership
  refreshStandby(state);

  return state;
}

function attachConnectionHandlers(state) {
  state.connection.on('stateChange', (oldState, newState) => {
    logEvent('voice_conn_state', {
      old: oldState.status,
      now: newState.status,
      guildId: state.guildId,
      channelId: state.channelId
    });

    if (newState.status === VoiceConnectionStatus.Disconnected) {
      logEvent('voice_disconnected', {
        guildId: state.guildId,
        channelId: state.channelId
      });

      if (state.manualLeave) return;

      attemptRejoin(state).catch((err) => {
        console.error('Rejoin failed', err);
      });
    }
  });
}

async function attemptRejoin(state) {
  const channel = await client.channels.fetch(state.channelId);
  if (!channel || !channel.isVoiceBased()) {
    console.error('Rejoin failed: channel missing or not voice');
    return;
  }

  const fresh = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  state.connection.destroy();
  state.connection = fresh;
  fresh.subscribe(state.player);
  attachConnectionHandlers(state);
  setupReceiver(state, state.guildId, state.channelId);

  logEvent('voice_reconnect', {
    guildId: state.guildId,
    channelId: state.channelId
  });
}

function refreshStandby(state) {
  try {
    const ch = client.channels.cache.get(state.channelId);
    const allowCount =
      ch && ch.isVoiceBased?.()
        ? [...ch.members.values()].filter((m) => !m.user?.bot && ALLOWLIST.has(m.id)).length
        : 0;

    const shouldStandby = allowCount === 0;
    if (shouldStandby === state.standby) return;

    state.standby = shouldStandby;

    if (state.standby) {
      logEvent('standby_on', { guildId: state.guildId, channelId: state.channelId });
      // Stop all active recordings to avoid STT usage while alone
      for (const userId of [...state.recordings.keys()]) {
        cleanupRecording(state, userId);
      }
    } else {
      logEvent('standby_off', { guildId: state.guildId, channelId: state.channelId });
      // Prime again for any allowlisted users currently present
      if (ch?.isVoiceBased?.()) {
        for (const [memberId] of ch.members) {
          if (!ALLOWLIST.has(memberId)) continue;
          startRecording(state, memberId);
        }
      }
    }
  } catch (err) {
    console.error('refreshStandby error', err);
  }
}

async function primeSubscriptions(state, voiceChannel) {
  try {
    // voiceChannel.members is a Collection of members in the voice channel
    for (const [memberId] of voiceChannel.members) {
      if (!ALLOWLIST.has(memberId)) continue;
      if (state.standby) continue;
      startRecording(state, memberId);
    }
  } catch (err) {
    console.error('primeSubscriptions failed', err);
  }
}

function startRecording(state, userId) {
  if (!ALLOWLIST.has(userId)) return;
  if (state.standby) return;
  if (state.recordings.has(userId)) return;

  const receiver = state.connection.receiver;

  logEvent('recording_start', {
    userId,
    guildId: state.guildId,
    channelId: state.channelId
  });

  // Keep a persistent subscription open so we don't depend on speaking events
  // or timing (subscribe-before-speech). We'll segment utterances ourselves.
  const opusStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.Manual
    }
  });

  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960
  });

  const pcmStream = opusStream.pipe(decoder);

  const recording = {
    userId,
    startedAt: null,
    lastAudioAt: 0,
    active: false,
    chunks: [],
    bytes: 0,
    // ring buffer before voice is detected, to avoid cutting the first syllable
    preRoll: [],
    preRollBytes: 0,
    // barge-in detector
    bargeHits: 0,
    bargeLastAt: 0,
    opusStream,
    pcmStream,
    channelId: state.channelId,
    guildId: state.guildId
  };

  state.recordings.set(userId, recording);

  pcmStream.on('data', (chunk) => {
    const now = Date.now();
    const rms = computeRms(chunk);
    const energetic = rms >= SILENCE_THRESHOLD;

    // While bot is speaking, ignore audio to avoid noise, BUT allow barge-in.
    if (
      state.player.state.status === AudioPlayerStatus.Playing ||
      state.player.state.status === AudioPlayerStatus.Buffering
    ) {
      if (BARGE_IN_ENABLED && rms >= BARGE_IN_THRESHOLD) {
        // require a couple of consecutive hits to avoid false positives
        if (now - (recording.bargeLastAt || 0) < 250) recording.bargeHits += 1;
        else recording.bargeHits = 1;
        recording.bargeLastAt = now;

        if (recording.bargeHits >= 2) {
          recording.bargeHits = 0;
          logEvent('barge_in', { userId, rms });
          try {
            state.player.stop(true);
          } catch {}
          // Kill current transcoder if any to avoid EPIPE / dangling processes
          if (state.currentPlayback) {
            try {
              state.currentPlayback.kill('SIGKILL');
            } catch {}
            state.currentPlayback = null;
          }
          // continue processing this chunk as potential speech start
        } else {
          return;
        }
      } else {
        recording.preRoll = [];
        recording.preRollBytes = 0;
        return;
      }
    }

    // Maintain a short pre-roll buffer while not active
    if (!recording.active) {
      const maxPreRollBytes = Math.floor((PRE_ROLL_MS / 1000) * 48000 * 2 * 2);
      recording.preRoll.push(chunk);
      recording.preRollBytes += chunk.length;
      while (recording.preRollBytes > maxPreRollBytes && recording.preRoll.length > 1) {
        const removed = recording.preRoll.shift();
        recording.preRollBytes -= removed.length;
      }

      if (!energetic) return;

      // Start of an utterance (include pre-roll)
      recording.active = true;
      recording.startedAt = now;
      recording.lastAudioAt = now;
      recording.chunks = [...recording.preRoll];
      recording.bytes = recording.preRollBytes;
      recording.preRoll = [];
      recording.preRollBytes = 0;

      logEvent('utterance_start', { userId });
    }

    // While active, keep buffering
    if (energetic) recording.lastAudioAt = now;
    recording.chunks.push(chunk);
    recording.bytes += chunk.length;

    const durationMs = bytesToMs(recording.bytes);
    if (durationMs >= MAX_UTTERANCE_MS) {
      logEvent('utterance_too_long', {
        userId: recording.userId,
        durationMs
      });
      // We'll finalize via the timer.
    }
  });

  pcmStream.on('error', (err) => {
    console.error('PCM stream error', err);
    cleanupRecording(state, userId);
  });

  const endAndFinalize = (reason) => {
    const durationMs = bytesToMs(recording.bytes);
    logEvent('recording_end', { userId, durationMs, reason });

    if (durationMs >= MIN_UTTERANCE_MS) {
      finalizeRecording(state, recording).catch((err) => {
        console.error('Finalize error', err);
      });
    }

    cleanupRecording(state, userId);
    try {
      opusStream.destroy();
    } catch {}

    // Rearm: keep a "hot" subscription so we don't depend on speaking events.
    // If the user is still in the channel, start a fresh recording shortly after.
    setTimeout(() => {
      try {
        const channel = client.channels.cache.get(state.channelId);
        const stillHere = channel?.isVoiceBased?.() && channel.members?.has?.(userId);
        if (!stillHere) return;
        if (state.manualLeave) return;
        if (state.recordings.has(userId)) return;

        logEvent('recording_rearm', {
          userId,
          guildId: state.guildId,
          channelId: state.channelId,
          prevReason: reason,
          prevDurationMs: durationMs
        });
        startRecording(state, userId);
      } catch (err) {
        console.error('recording_rearm error', err);
      }
    }, 250);
  };

  // Silence detector: segments utterances while keeping subscription open
  const interval = setInterval(() => {
    if (!recording.active) return;

    const now = Date.now();
    const silenceFor = now - recording.lastAudioAt;
    const durationMs = bytesToMs(recording.bytes);

    if (durationMs >= MAX_UTTERANCE_MS) {
      // Finalize current utterance
      logEvent('recording_end', { userId, durationMs, reason: 'max_utterance' });
      finalizeRecording(state, recording).catch((err) => console.error('Finalize error', err));
      // Reset for next utterance
      recording.active = false;
      recording.startedAt = null;
      recording.lastAudioAt = 0;
      recording.chunks = [];
      recording.bytes = 0;
      return;
    }

    if (silenceFor >= SILENCE_MS && durationMs >= MIN_UTTERANCE_MS) {
      logEvent('recording_end', { userId, durationMs, reason: 'silence_timer' });
      finalizeRecording(state, recording).catch((err) => console.error('Finalize error', err));
      recording.active = false;
      recording.startedAt = null;
      recording.lastAudioAt = 0;
      recording.chunks = [];
      recording.bytes = 0;
      return;
    }

    if (silenceFor >= SILENCE_MS * 10) {
      // Reset stuck utterance
      recording.active = false;
      recording.startedAt = null;
      recording.lastAudioAt = 0;
      recording.chunks = [];
      recording.bytes = 0;
    }
  }, 200);

  state.timers.set(userId, interval);

  opusStream.on('close', () => {
    logEvent('opus_close', { userId });
    cleanupRecording(state, userId);
  });
  opusStream.on('error', (err) => {
    console.error('Opus stream error', err);
    cleanupRecording(state, userId);
  });
}

function setupReceiver(state, guildId, channelId) {
  // Keep this function to preserve the callsite; all logic is in startRecording/primeSubscriptions.
  logEvent('receiver_ready', { guildId, channelId });
}

async function finalizeRecording(state, recording) {
  if (isRateLimited(recording.userId, 'stt')) {
    logEvent('rate_limited_stt', {
      userId: recording.userId
    });
    return;
  }

  const pcmBuffer = Buffer.concat(recording.chunks);
  const wavBuffer = await pcmToWavForStt(pcmBuffer, 48000, 2);

  logEvent('stt_request', {
    userId: recording.userId,
    guildId: recording.guildId,
    channelId: recording.channelId,
    wavBytes: wavBuffer.length,
    sttRate: STT_SAMPLE_RATE
  });
  const text = await transcribe(wavBuffer);
  logEvent('stt_result', {
    userId: recording.userId,
    text: (text || '').slice(0, 300),
    textLen: (text || '').length
  });
  if (!text) return;

  const reply = await askOpenClaw(text, recording);
  logEvent('agent_reply', {
    userId: recording.userId,
    reply: (reply || '').slice(0, 300),
    replyLen: (reply || '').length
  });
  if (!reply) return;

  await speak(state, reply, recording.userId);
}

function cleanupRecording(state, userId) {
  const interval = state.timers.get(userId);
  if (interval) clearInterval(interval);
  state.timers.delete(userId);

  const rec = state.recordings.get(userId);
  if (rec?.opusStream) {
    try {
      rec.opusStream.destroy();
    } catch {}
  }
  if (rec?.pcmStream) {
    try {
      rec.pcmStream.destroy();
    } catch {}
  }

  state.recordings.delete(userId);
}

function bytesToMs(bytes) {
  const bytesPerSecond = 48000 * 2 * 2;
  return Math.round((bytes / bytesPerSecond) * 1000);
}

function computeRms(chunk) {
  let sum = 0;
  const samples = chunk.length / 2;
  for (let i = 0; i < chunk.length; i += 2) {
    const int16 = chunk.readInt16LE(i);
    const sample = int16 / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

function hasVoiceEnergy(chunk, threshold) {
  return computeRms(chunk) >= threshold;
}

async function pcmToWav(pcmBuffer, sampleRate, channels) {
  const floatData = new Float32Array(pcmBuffer.length / 2);
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const int16 = pcmBuffer.readInt16LE(i);
    floatData[i / 2] = int16 / 32768;
  }

  const channelData = [];
  const frames = floatData.length / channels;
  for (let c = 0; c < channels; c++) {
    const channel = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      channel[i] = floatData[i * channels + c];
    }
    channelData.push(channel);
  }

  const wav = await wavEncoder.encode({
    sampleRate,
    channelData
  });
  return Buffer.from(wav);
}

async function pcmToWavForStt(pcmBuffer, sampleRate, channels) {
  // Use ffmpeg to resample to 16kHz mono WAV to reduce latency and improve STT stability.
  // Fallback to JS wav encoder if ffmpeg fails.
  try {
    const { spawn } = await import('node:child_process');

    const out = await new Promise((resolve, reject) => {
      const ff = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          's16le',
          '-ar',
          String(sampleRate),
          '-ac',
          String(channels),
          '-i',
          'pipe:0',
          '-ac',
          '1',
          '-ar',
          String(STT_SAMPLE_RATE),
          '-c:a',
          'pcm_s16le',
          '-f',
          'wav',
          'pipe:1'
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );

      const chunks = [];
      let size = 0;
      let stderr = '';

      ff.stdout.on('data', (d) => {
        chunks.push(d);
        size += d.length;
      });
      ff.stderr.on('data', (d) => (stderr += d.toString()));

      ff.on('error', reject);
      ff.on('exit', (code) => {
        if (code === 0) return resolve(Buffer.concat(chunks, size));
        reject(new Error(`ffmpeg stt resample failed (code=${code}): ${stderr}`));
      });

      ff.stdin.end(pcmBuffer);
    });

    return out;
  } catch (err) {
    console.error('pcmToWavForStt fallback to JS encoder', err);
    return pcmToWav(pcmBuffer, sampleRate, channels);
  }
}

async function transcribe(wavBuffer) {
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', WHISPER_MODEL);
  // Force Italian to avoid random English garbage when audio is short/noisy
  form.append('language', 'it');
  form.append('temperature', '0');

  const res = await fetch(`${OPENAI_BASE_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: form
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('Transcription error', res.status, text);
    return '';
  }

  const json = await res.json();
  return json.text?.trim() || '';
}

async function askOpenClaw(text, recording) {
  const payload = {
    text,
    userId: recording.userId,
    guildId: recording.guildId,
    channelId: recording.channelId
  };

  const res = await fetch(OPENCLAW_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('OpenClaw endpoint error', res.status, body);
    return '';
  }

  const json = await res.json();
  return json.reply?.trim() || '';
}

async function speak(state, text, userId) {
  if (isRateLimited(userId || 'unknown', 'tts')) {
    logEvent('rate_limited_tts', {
      userId: userId || 'unknown'
    });
    return;
  }

  logEvent('tts_request', {
    userId: userId || 'unknown',
    guildId: state.guildId,
    channelId: state.channelId
  });

  logEvent('speak_begin', { userId: userId || 'unknown' });

  // Ensure voice connection is ready before attempting playback
  try {
    await entersState(state.connection, VoiceConnectionStatus.Ready, 30_000);
    logEvent('voice_ready_ok', { userId: userId || 'unknown' });
  } catch (err) {
    console.error('Voice connection not ready for playback', err);
    logEvent('voice_ready_fail', { userId: userId || 'unknown' });
    return;
  }

  const provider = (process.env.TTS_PROVIDER || 'openai').toLowerCase();

  const { spawn } = await import('node:child_process');

  // --- OpenAI TTS (fast, online) ---
  if (provider === 'openai') {
    logEvent('openai_tts_request', { userId: userId || 'unknown' });

    const res = await fetch(`${OPENAI_BASE_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: TTS_VOICE,
        format: 'mp3',
        input: String(text || '').slice(0, 800)
      })
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('OpenAI TTS error', res.status, body);
      return;
    }

    const audioBuf = Buffer.from(await res.arrayBuffer());

    const ffmpeg = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    // Track active transcoder so barge-in can kill it safely
    state.currentPlayback = ffmpeg;

    let ffErr = '';
    ffmpeg.stderr.on('data', (d) => (ffErr += d.toString()));
    ffmpeg.stdin.on('error', (err) => {
      // Expected when we barge-in and kill ffmpeg mid-write
      if (err?.code === 'EPIPE') return;
      console.error('ffmpeg stdin error', err);
    });
    ffmpeg.stdout.on('error', (err) => {
      console.error('ffmpeg stdout error', err);
    });

    ffmpeg.on('exit', (code) => {
      if (state.currentPlayback === ffmpeg) state.currentPlayback = null;
      if (code && code !== 0) {
        console.error('ffmpeg failed', code, ffErr);
      } else {
        logEvent('ffmpeg_ok', { userId: userId || 'unknown' });
      }
    });

    ffmpeg.stdin.end(audioBuf);

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
    state.player.play(resource);
    logEvent('player_play', { userId: userId || 'unknown' });

    return;
  }

  // --- Sherpa offline fallback ---
  const runtimeDir = process.env.SHERPA_ONNX_RUNTIME_DIR || '';
  const modelDir = process.env.SHERPA_ONNX_MODEL_DIR || '';

  if (!runtimeDir || !modelDir) {
    console.error('Missing SHERPA_ONNX_RUNTIME_DIR / SHERPA_ONNX_MODEL_DIR (local TTS not configured)');
    return;
  }

  // 1) Generate WAV via sherpa-onnx
  const outWav = `/tmp/niko-tts-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`;

  const modelFile = process.env.SHERPA_ONNX_MODEL_FILE || `${modelDir}/en_US-lessac-high.onnx`;
  const tokensFile = process.env.SHERPA_ONNX_TOKENS_FILE || `${modelDir}/tokens.txt`;
  const dataDir = process.env.SHERPA_ONNX_DATA_DIR || `${modelDir}/espeak-ng-data`;

  const sherpaExe = `${runtimeDir}/bin/sherpa-onnx-offline-tts`;
  const libDir = `${runtimeDir}/lib`;

  // 1) Generate WAV via sherpa-onnx binary (offline)
  logEvent('sherpa_spawn', { userId: userId || 'unknown' });
  await new Promise((resolve, reject) => {
    const env = { ...process.env };
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${libDir}:${env.LD_LIBRARY_PATH}` : libDir;

    const p = spawn(
      sherpaExe,
      [
        `--vits-model=${modelFile}`,
        `--vits-tokens=${tokensFile}`,
        `--vits-data-dir=${dataDir}`,
        `--output-filename=${outWav}`,
        text
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env }
    );

    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`sherpa-onnx-offline-tts failed (code=${code}): ${stderr}`));
    });

    // Hard timeout
    setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch {}
      reject(new Error('sherpa timeout'));
    }, 15_000);
  })
    .then(() => logEvent('sherpa_ok', { userId: userId || 'unknown' }))
    .catch((err) => {
      console.error('Local TTS error', err);
      logEvent('sherpa_fail', { userId: userId || 'unknown' });
    });

  // 2) Transcode WAV -> raw PCM and play (discordjs/voice will opus-encode)
  const ffmpeg = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', outWav, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  state.currentPlayback = ffmpeg;

  let ffErr = '';
  ffmpeg.stderr.on('data', (d) => (ffErr += d.toString()));
  ffmpeg.stdout.on('error', (err) => {
    console.error('ffmpeg stdout error', err);
  });
  ffmpeg.on('exit', (code) => {
    if (state.currentPlayback === ffmpeg) state.currentPlayback = null;
    if (code && code !== 0) {
      console.error('ffmpeg failed', code, ffErr);
    } else {
      logEvent('ffmpeg_ok', { userId: userId || 'unknown' });
    }
  });

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
  state.player.play(resource);
  logEvent('player_play', { userId: userId || 'unknown' });

  // Cleanup temp wav a bit later
  setTimeout(async () => {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(outWav);
    } catch {}
  }, 30_000);

  if (state.player.state.status === AudioPlayerStatus.Playing) {
    await delay(100);
  }
}

function isRateLimited(userId, kind) {
  const now = Date.now();
  const entry = rateLimits.get(userId) || {
    windowStart: now,
    sttCount: 0,
    ttsCount: 0
  };

  if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    entry.windowStart = now;
    entry.sttCount = 0;
    entry.ttsCount = 0;
  }

  if (kind === 'stt') {
    if (entry.sttCount >= RATE_LIMIT_STT_MAX) {
      rateLimits.set(userId, entry);
      return true;
    }
    entry.sttCount += 1;
  }

  if (kind === 'tts') {
    if (entry.ttsCount >= RATE_LIMIT_TTS_MAX) {
      rateLimits.set(userId, entry);
      return true;
    }
    entry.ttsCount += 1;
  }

  rateLimits.set(userId, entry);
  return false;
}

function logEvent(event, data) {
  const payload = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${new Date().toISOString()}] ${event}${payload}`);
}

client.login(DISCORD_TOKEN);
