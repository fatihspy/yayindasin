// All runtime settings come from environment variables (see .env.example).
const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);

export const config = {
  port: Number(process.env.PORT) || 8080,

  // Anthropic
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicBaseURL: process.env.ANTHROPIC_BASE_URL || undefined, // only for tests / proxies
  modelQuick: process.env.MODEL_QUICK || 'claude-haiku-5-5',     // translations
  modelDefault: process.env.MODEL_DEFAULT || 'claude-sonnet-5-5', // content generation, CV text
  maxPromptChars: Number(process.env.MAX_PROMPT_CHARS) || 24000,

  // Storage for trainer voices
  mongoUri: process.env.MONGODB_URI || '',
  mongoDb: process.env.MONGODB_DB || 'yayindasin',
  maxVoiceBytes: Number(process.env.MAX_VOICE_MB || 15) * 1024 * 1024,

  // Access
  appKey: process.env.APP_KEY || '',         // shared key shipped inside the app (light abuse filter, not a secret)
  trainerKey: process.env.TRAINER_KEY || '', // only trainers know this; required to upload/delete voices
  corsOrigins: list(process.env.CORS_ORIGINS).length
    ? list(process.env.CORS_ORIGINS)
    : ['capacitor://localhost', 'https://localhost', 'http://localhost', 'ionic://localhost'],

  // Rate limits (per IP)
  aiPerMinute: Number(process.env.AI_PER_MINUTE) || 30,
  aiPerDay: Number(process.env.AI_PER_DAY) || 400,
  trustProxy: process.env.TRUST_PROXY ?? '1', // Render sits behind one proxy
};
