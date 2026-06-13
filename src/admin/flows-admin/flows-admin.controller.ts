import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FlowsService } from '../../flows/flows.service';
import { CreateFlowDto } from '../../flows/dto/create-flow.dto';
import { UpdateFlowDto } from '../../flows/dto/update-flow.dto';
import { CreateFlowNodeDto, UpdateFlowNodeDto } from '../../flows/dto/flow-node.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';

@UseGuards(JwtAuthGuard)
@Controller('api/admin/v1/flows')
export class FlowsAdminController {
  constructor(private readonly flowsService: FlowsService) {}

  // ─── Flows ───────────────────────────────────────────────────────────────

  @Get()
  async findAll(@CurrentUser() user: AuthUser) {
    return this.flowsService.findAll(user.clinicId);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.flowsService.findById(user.clinicId, id);
  }

  @Post()
  async create(@Body() dto: CreateFlowDto, @CurrentUser() user: AuthUser) {
    return this.flowsService.create(user.clinicId, dto);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateFlowDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.flowsService.update(user.clinicId, id, dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.flowsService.delete(user.clinicId, id);
    return { success: true };
  }

  // ─── Activation ──────────────────────────────────────────────────────────

  @Post(':id/activate')
  async activate(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.flowsService.activate(user.clinicId, id);
  }

  @Post('deactivate')
  async deactivate(@CurrentUser() user: AuthUser) {
    await this.flowsService.deactivate(user.clinicId);
    return { success: true };
  }

  @Get('active')
  async getActive(@CurrentUser() user: AuthUser) {
    return this.flowsService.getActiveFlow(user.clinicId);
  }

  // ─── Nodes ───────────────────────────────────────────────────────────────

  @Post(':flowId/nodes')
  async addNode(
    @Param('flowId') flowId: string,
    @Body() dto: CreateFlowNodeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.flowsService.addNode(user.clinicId, flowId, dto);
  }

  @Put(':flowId/nodes/:nodeId')
  async updateNode(
    @Param('flowId') flowId: string,
    @Param('nodeId') nodeId: string,
    @Body() dto: UpdateFlowNodeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.flowsService.updateNode(user.clinicId, flowId, nodeId, dto);
  }

  @Delete(':flowId/nodes/:nodeId')
  async removeNode(
    @Param('flowId') flowId: string,
    @Param('nodeId') nodeId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.flowsService.deleteNode(user.clinicId, flowId, nodeId);
    return { success: true };
  }

  @Patch(':flowId/nodes/reorder')
  async reorderNodes(
    @Param('flowId') flowId: string,
    @Body('nodeIds') nodeIds: string[],
    @CurrentUser() user: AuthUser,
  ) {
    return this.flowsService.reorderNodes(user.clinicId, flowId, nodeIds);
  }
}