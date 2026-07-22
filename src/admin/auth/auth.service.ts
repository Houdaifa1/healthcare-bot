import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async login(email: string, password: string) {
    const agent = await this.prisma.adminUser.findUnique({ where: { email } });

    if (!agent) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await bcrypt.compare(password, agent.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = {
      sub: agent.id,
      email: agent.email,
      role: agent.role,
      clinicId: agent.clinicId ?? 'main',
    };

    const token = this.jwtService.sign(payload);

    return {
      access_token: token,
      admin: {
        id: agent.id,
        email: agent.email,
        role: agent.role,
        clinicId: agent.clinicId ?? 'main',
      },
    };
  }
}
