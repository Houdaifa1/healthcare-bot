import { Global, Module } from '@nestjs/common';
import { SessionsService } from './sessions.service';

@Global()
@Module({
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
