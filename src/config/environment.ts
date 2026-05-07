export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'https://app.evidentlyaeo.com',
  apiUrl: process.env.API_URL || 'https://api.evidentlyaeo.com',
  jwt: {
    secret: process.env.JWT_SECRET || '',
  },
};
