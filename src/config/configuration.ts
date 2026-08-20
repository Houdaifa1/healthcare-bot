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
    accessToken:   process.env.META_ACCESS_TOKEN,
    phoneNumberId: process.env.META_PHONE_NUMBER_ID,
    verifyToken:   process.env.META_VERIFY_TOKEN,
    appSecret:     process.env.META_APP_SECRET,
    apiVersion:    process.env.META_API_VERSION || 'v20.0',
  },

  ai: {
    apiKey: process.env.GROQ_API_KEY,
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },

  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
  },

  jwt: {
    secret: process.env.JWT_SECRET,
  },

  clinops: {
    mode: process.env.CLINOPS_MODE || 'mock',
  },

  campaign: {
    // Approved Meta template used for the outbound opening message. Template
    // names/languages are specific to each WhatsApp Business account, so they
    // must be configurable, never hardcoded in the send path.
    openingTemplateName: process.env.CAMPAIGN_OPENING_TEMPLATE_NAME || 'patient_followup',
    openingTemplateLanguage: process.env.CAMPAIGN_OPENING_TEMPLATE_LANGUAGE || 'fr',
  },
});