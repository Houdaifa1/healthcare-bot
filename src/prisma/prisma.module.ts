import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';


@Global() // so I can make the prisma module available globally, just import it once in the app module
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}