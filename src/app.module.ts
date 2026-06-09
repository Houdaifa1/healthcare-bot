import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { QueueModule } from './queue/queue.module';
import { SessionsModule } from './sessions/sessions.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: '.env',
    }),
    PrismaModule,
    SessionsModule,
    OrchestratorModule,
    QueueModule,
    WhatsAppModule,
    AdminModule,
  ],
})
export class AppModule {}