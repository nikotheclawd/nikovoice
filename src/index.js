import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  EndBehaviorType,
  VoiceConnectionStatus
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

const SILENCE_MS = Number(process.env.SILENCE_MS || 1200);
const MIN_UTTERANCE_MS = Number(process.env.MIN_UTTERANCE_MS || 700);
const SILENCE_THRESHOLD = Number(process.env.SILENCE_THRESHOLD || 0.01); // RMS threshold 0-1
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

  const state = {
    connection,
    player,
    recordings: new Map(),
    timers: new Map(),
    guildId: voiceChannel.guild.id,
    channelId: voiceChannel.id,
    manualLeave: Boolean(manualLeave),
    autoJoin: Boolean(autoJoin)
  };

  connections.set(voiceChannel.guild.id, state);

  attachConnectionHandlers(state);
  setupReceiver(state, voiceChannel.guild.id, voiceChannel.id);

  logEvent('voice_join', {
    guildId: voiceChannel.guild.id,
    channelId: voiceChannel.id,
    autoJoin: Boolean(autoJoin)
  });

  return state;
}

function attachConnectionHandlers(state) {
  state.connection.on('stateChange', (oldState, newState) => {
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

function setupReceiver(state, guildId, channelId) {
  const receiver = state.connection.receiver;

  receiver.speaking.on('start', (userId) => {
    logEvent('speaking_start', {
      userId,
      guildId,
      channelId
    });

    if (!ALLOWLIST.has(userId)) {
      logEvent('speaking_ignored_not_allowlisted', {
        userId,
        guildId,
        channelId
      });
      return;
    }
    if (state.recordings.has(userId)) return;

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
      startedAt: Date.now(),
      lastAudioAt: Date.now(),
      chunks: [],
      bytes: 0,
      channelId,
      guildId
    };

    state.recordings.set(userId, recording);

    pcmStream.on('data', (chunk) => {
      recording.chunks.push(chunk);
      recording.bytes += chunk.length;

      if (hasVoiceEnergy(chunk, SILENCE_THRESHOLD)) {
        recording.lastAudioAt = Date.now();
      }
    });

    pcmStream.on('error', (err) => {
      console.error('PCM stream error', err);
      cleanupRecording(state, userId);
    });

    const interval = setInterval(() => {
      const now = Date.now();
      const silenceFor = now - recording.lastAudioAt;
      const durationMs = bytesToMs(recording.bytes);

      if (durationMs >= MAX_UTTERANCE_MS) {
        logEvent('utterance_too_long', {
          userId: recording.userId,
          durationMs
        });
        cleanupRecording(state, userId);
        return;
      }

      if (silenceFor >= SILENCE_MS && durationMs >= MIN_UTTERANCE_MS) {
        finalizeRecording(state, recording).catch((err) => {
          console.error('Finalize error', err);
        });
        cleanupRecording(state, userId);
      }

      if (silenceFor >= SILENCE_MS * 4) {
        cleanupRecording(state, userId);
      }
    }, 200);

    state.timers.set(userId, interval);
  });
}

async function finalizeRecording(state, recording) {
  if (isRateLimited(recording.userId, 'stt')) {
    logEvent('rate_limited_stt', {
      userId: recording.userId
    });
    return;
  }

  const pcmBuffer = Buffer.concat(recording.chunks);
  const wavBuffer = await pcmToWav(pcmBuffer, 48000, 2);

  logEvent('stt_request', {
    userId: recording.userId,
    guildId: recording.guildId,
    channelId: recording.channelId
  });
  const text = await transcribe(wavBuffer);
  if (!text) return;

  const reply = await askOpenClaw(text, recording);
  if (!reply) return;

  await speak(state, reply, recording.userId);
}

function cleanupRecording(state, userId) {
  const interval = state.timers.get(userId);
  if (interval) clearInterval(interval);
  state.timers.delete(userId);
  state.recordings.delete(userId);
}

function bytesToMs(bytes) {
  const bytesPerSecond = 48000 * 2 * 2;
  return Math.round((bytes / bytesPerSecond) * 1000);
}

function hasVoiceEnergy(chunk, threshold) {
  let sum = 0;
  const samples = chunk.length / 2;
  for (let i = 0; i < chunk.length; i += 2) {
    const int16 = chunk.readInt16LE(i);
    const sample = int16 / 32768;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples);
  return rms >= threshold;
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

async function transcribe(wavBuffer) {
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', WHISPER_MODEL);

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

  const res = await fetch(`${OPENAI_BASE_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
      response_format: 'opus'
    })
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('TTS error', res.status, body);
    return;
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const stream = Readable.from(buffer);
  const resource = createAudioResource(stream, { inputType: StreamType.OggOpus });

  state.player.play(resource);

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
