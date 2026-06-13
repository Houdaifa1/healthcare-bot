import { Module } from '@nestjs/common';
import { FlowsAdminController } from './flows-admin.controller';
import { FlowsModule } from '../../flows/flows.module';

@Module({
  imports: [FlowsModule],
  controllers: [FlowsAdminController],
})
export class FlowsAdminModule {}