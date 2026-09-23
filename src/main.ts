import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { validateEnvironment } from '@platform/config/configuration';

async function bootstrap() {
  // Before Nest builds anything: a missing DATABASE_URL or a live-mode ClinOps
  // config with no credentials must fail here, with a message naming the key,
  // rather than 20 modules later as an opaque provider error.
  try {
    validateEnvironment();
  } catch (err) {
    new Logger('Bootstrap').error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  const configService = app.get(ConfigService);

  // Origins come from config so the deployment hostname lives in exactly one
  // place (PUBLIC_HOSTNAME / CORS_ORIGINS in .env), not in this file.
  app.enableCors({
    origin: configService.get<string[]>('corsOrigins', []),
    credentials: true,
  });

  // Helmet — no QR page anymore, so one uniform policy for everything
  app.use(helmet());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = configService.get<number>('port', 3000);

  await app.listen(port);
  console.log(`Healthcare bot running on port ${port}`);
}

bootstrap();
