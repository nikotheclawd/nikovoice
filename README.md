# Discord Voice Bot (STT -> Local HTTP -> TTS)

A minimal Discord voice bot that:

- Joins a voice channel
- Captures user audio
- Runs STT via OpenAI Whisper API
- Sends text to a local HTTP endpoint (placeholder for OpenClaw)
- Synthesizes TTS via OpenAI TTS API
- Plays speech back into the channel

## Requirements

- Node.js 22 (for `fetch`, `FormData`, `Blob`)
- Linux build tools for native modules

If you see native module build errors, install system deps (Ubuntu example):

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3 make g++
```

## Setup

1. Install dependencies

```bash
npm install
```

2. Create a `.env` file in the project root:

```bash
DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN
OPENAI_API_KEY=YOUR_OPENAI_API_KEY
OPENCLAW_ENDPOINT=http://localhost:8000/respond

# Optional
OPENAI_BASE_URL=https://api.openai.com
WHISPER_MODEL=whisper-1
TTS_MODEL=gpt-4o-mini-tts
TTS_VOICE=alloy
VOICE_CHANNEL_ID=YOUR_VOICE_CHANNEL_ID
SILENCE_MS=1200
MIN_UTTERANCE_MS=700
SILENCE_THRESHOLD=0.01
MAX_UTTERANCE_MS=15000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_STT_MAX=10
RATE_LIMIT_TTS_MAX=10
```

3. Run the bot

```bash
npm start
```

4. In Discord, use:

- `!join` to join your current voice channel
- `!leave` to disconnect

## Allowlist

Only these user IDs are allowed to trigger commands and be transcribed/handled:

- `323379312608673803` (giveme11us)
- `381895367861600258` (living3stripes)

All other users in voice are ignored.

## 24/7 Auto-Join

Set `VOICE_CHANNEL_ID` to auto-join a voice channel on startup. The bot will attempt to re-join if disconnected.

## Discord App Permissions

Enable these **Gateway Intents** in the Discord Developer Portal:

- Server Members (optional)
- Message Content (required for `!join` and `!leave`)
- Presence (not required)

Add these **Bot Permissions** when inviting the bot:

- `View Channels`
- `Connect`
- `Speak`
- `Read Message History`
- `Send Messages`

## Local HTTP Endpoint

The bot POSTs JSON to `OPENCLAW_ENDPOINT`:

```json
{
  "text": "transcribed user speech",
  "userId": "123",
  "guildId": "456",
  "channelId": "789"
}
```

Expected response:

```json
{ "reply": "text to speak" }
```

## Notes

- The bot uses a simple RMS-based silence timeout to detect end of speech.
- Audio capture is 48kHz stereo PCM before being encoded to WAV for STT.
- TTS audio is requested as `opus` and streamed directly to Discord.
- Rate limits and max utterance length are enforced in-memory to cap usage costs.

## systemd (Example)

Create `/etc/systemd/system/discord-voice-niko.service`:

```ini
[Unit]
Description=Discord Voice Bot (Niko)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/.openclaw/workspace/discord-voice-niko
ExecStart=/usr/bin/node /root/.openclaw/workspace/discord-voice-niko/src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN
Environment=OPENAI_API_KEY=YOUR_OPENAI_API_KEY
Environment=OPENCLAW_ENDPOINT=http://localhost:8000/respond
Environment=VOICE_CHANNEL_ID=YOUR_VOICE_CHANNEL_ID

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now discord-voice-niko
sudo systemctl status discord-voice-niko
```
