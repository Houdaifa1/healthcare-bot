import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuthService } from './auth/auth.service';
import { JwtStrategy } from './auth/jwt.strategy';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { ClinicModule } from './clinic/clinic.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BotMessagesModule } from './bot-messages/bot-messages.module';
import { SpecialtiesModule } from './specialties/specialties.module';
import { DoctorsModule } from './doctors/doctors.module';
import { TimeSlotsModule } from './timeslots/timeslots.module';
import { FaqsModule } from './faqs/faqs.module';

@Module({
  imports: [
    PrismaModule,
    PassportModule,
    WhatsAppModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '7d' },
      }),
      inject: [ConfigService],
    }),
    ClinicModule,
    BotMessagesModule,
    SpecialtiesModule,
    DoctorsModule,
    TimeSlotsModule,
    FaqsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AuthService, JwtStrategy],
  exports: [AdminService],
})
export class AdminModule {}