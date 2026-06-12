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
    // Meta Cloud API credentials
    accessToken:   process.env.META_ACCESS_TOKEN,
    phoneNumberId: process.env.META_PHONE_NUMBER_ID,
    verifyToken:   process.env.META_VERIFY_TOKEN,
    appSecret:     process.env.META_APP_SECRET,
    // Graph API version — bump here when Meta deprecates an older version
    apiVersion:    process.env.META_API_VERSION || 'v20.0',
  },

  ai: {
    apiKey: process.env.GEMINI_API_KEY,
  },

  jwt: {
    secret: process.env.JWT_SECRET,
  },
});