// This is a stub for the public repo. 
// All values are loaded from environment variables at runtime.
export const config = {
  frontendUrl: process.env.FRONTEND_URL || 'https://app.evidentlyaeo.com',
  apiUrl: process.env.API_URL || 'https://api.evidentlyaeo.com',
  jwt: {
    secret: process.env.SUPABASE_JWT_SECRET || '',
  },
};
