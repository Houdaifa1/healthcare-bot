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
    verifyToken: process.env.META_VERIFY_TOKEN,
    accessToken: process.env.META_ACCESS_TOKEN,
    phoneNumberId: process.env.META_PHONE_NUMBER_ID,
    appSecret: process.env.META_APP_SECRET,
    bossPhone: process.env.BOSS_PHONE_NUMBER,
  },

  ai: {
  apiKey: process.env.GEMINI_API_KEY,
},

  jwt: {
    secret: process.env.JWT_SECRET,
  },
});