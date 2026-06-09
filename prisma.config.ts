import path from 'node:path';
import { defineConfig } from 'prisma/config';
import { config } from 'dotenv';

config({ path: path.join(process.cwd(), '.env') });

const connectionString = process.env.DATABASE_URL ?? '';
const isDigitalOcean = connectionString.includes('db.ondigitalocean.com');

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  datasource: {
    url: connectionString,
  },
});