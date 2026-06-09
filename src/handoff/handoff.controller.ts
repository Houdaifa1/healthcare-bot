import { Controller, Post, Body, UseGuards, Logger } from '@nestjs/common';
import { HandoffService } from './handoff.service';
import { JwtAuthGuard } from '../admin/auth/jwt-auth.guard';

// This DTO would be used by an internal admin tool
// for an agent to claim a chat and send a message.
class AgentMessageDto {
  sessionId: string;
  message: string;
}

// This DTO would be used by an internal admin tool
// for an agent to resolve a handoff.
class ResolveHandoffDto {
  sessionId: string;
}

@Controller('api/admin/v1/handoff')
export class HandoffController {
  private readonly logger = new Logger(HandoffController.name);

  constructor(private readonly handoffService: HandoffService) {}

  // This endpoint would be called by an internal admin panel
  // when a human agent decides to resolve the handoff and return
  // the user to the bot's control.
  @UseGuards(JwtAuthGuard)
  @Post('resolve')
  async resolveHandoff(@Body() resolveHandoffDto: ResolveHandoffDto) {
    this.logger.log(
      `Received request to resolve handoff for session: ${resolveHandoffDto.sessionId}`,
    );
    await this.handoffService.resolveHandoff(resolveHandoffDto.sessionId);
    return { message: 'Handoff resolved successfully.' };
  }

  // Note: A real-time handoff system would likely use WebSockets
  // for communication between the agent's dashboard and the server,
  // rather than simple HTTP endpoints. This controller is a simplified
  // representation for agents to interact with the handoff process.
}
