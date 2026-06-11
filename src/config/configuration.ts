export default () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),

  database: {
    url: process.env.DATABASE_URL,
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  whatsapp: {
    authPath: process.env.BAILEYS_AUTH_PATH || './baileys-auth',
    qrToken: process.env.QR_TOKEN,
  },

  ai: {
    apiKey: process.env.GEMINI_API_KEY,
  },

  jwt: {
    secret: process.env.JWT_SECRET,
  },
});