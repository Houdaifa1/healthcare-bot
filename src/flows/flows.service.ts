import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { NodeType } from '@prisma/client';
import { CreateFlowDto } from './dto/create-flow.dto';
import { UpdateFlowDto } from './dto/update-flow.dto';
import { CreateFlowNodeDto, UpdateFlowNodeDto } from './dto/flow-node.dto';

// Flow with nodes included
const flowWithNodes = Prisma.validator<Prisma.FlowDefaultArgs>()({
  include: { nodes: { orderBy: { position: 'asc' } } },
});

type FlowWithNodes = Prisma.FlowGetPayload<typeof flowWithNodes>;

@Injectable()
export class FlowsService {
  private readonly logger = new Logger(FlowsService.name);

  constructor(private prisma: PrismaService) {}

  // ─── Flow CRUD ───────────────────────────────────────────────────────────

  async findAll(clinicId: string): Promise<FlowWithNodes[]> {
    return this.prisma.flow.findMany({
      where: { clinicId },
      ...flowWithNodes,
      orderBy: { createdAt: 'desc' },
    }) as unknown as FlowWithNodes[];
  }

  async findById(clinicId: string, flowId: string): Promise<FlowWithNodes> {
    const flow = await this.prisma.flow.findFirst({
      where: { id: flowId, clinicId },
      ...flowWithNodes,
    });
    if (!flow) throw new NotFoundException('Flow not found');
    return flow as unknown as FlowWithNodes;
  }

  async create(clinicId: string, dto: CreateFlowDto): Promise<FlowWithNodes> {
    const existing = await this.prisma.flow.findUnique({
      where: { clinicId_name: { clinicId, name: dto.name } },
    });
    if (existing) {
      throw new ConflictException('A flow with this name already exists');
    }
    return this.prisma.flow.create({
      data: { clinicId, name: dto.name },
      ...flowWithNodes,
    }) as unknown as FlowWithNodes;
  }

  async update(
    clinicId: string,
    flowId: string,
    dto: UpdateFlowDto,
  ): Promise<FlowWithNodes> {
    await this.findById(clinicId, flowId);
    if (dto.name) {
      const existing = await this.prisma.flow.findUnique({
        where: { clinicId_name: { clinicId, name: dto.name } },
      });
      if (existing && existing.id !== flowId) {
        throw new ConflictException('A flow with this name already exists');
      }
    }
    return this.prisma.flow.update({
      where: { id: flowId },
      data: { ...(dto.name && { name: dto.name }) },
      ...flowWithNodes,
    }) as unknown as FlowWithNodes;
  }

  async delete(clinicId: string, flowId: string): Promise<void> {
    await this.findById(clinicId, flowId);
    // Deactivate if this flow was the active flow
    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: { activeFlowId: null as any },
    });
    await this.prisma.flowNode.deleteMany({ where: { flowId } });
    await this.prisma.flow.delete({ where: { id: flowId } });
  }

  // ─── Activation ──────────────────────────────────────────────────────────

  async activate(clinicId: string, flowId: string): Promise<FlowWithNodes> {
    const flow = await this.findById(clinicId, flowId);
    if (flow.nodes.length === 0) {
      throw new ConflictException('Cannot activate a flow with no nodes');
    }
    const firstNode = flow.nodes[0];
    if (firstNode.type === NodeType.END) {
      throw new ConflictException('First node cannot be an END node');
    }

    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: { activeFlowId: flowId },
    });
    this.logger.log(`Flow "${flow.name}" activated for clinic ${clinicId}`);
    return flow;
  }

  async deactivate(clinicId: string): Promise<void> {
    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: { activeFlowId: null },
    });
    this.logger.log(`Flow deactivated for clinic ${clinicId}`);
  }

  async getActiveFlow(clinicId: string): Promise<FlowWithNodes | null> {
    const result = await this.prisma.$queryRaw<any[]>(
      Prisma.sql`SELECT "activeFlowId" FROM "Clinic" WHERE "id" = ${clinicId} LIMIT 1`,
    );
    if (!result?.length || !result[0].activeFlowId) return null;

    const flow = await this.prisma.flow.findFirst({
      where: { id: result[0].activeFlowId, clinicId },
      ...flowWithNodes,
    });
    return flow as unknown as FlowWithNodes | null;
  }

  // ─── Node CRUD ───────────────────────────────────────────────────────────

  async addNode(
    clinicId: string,
    flowId: string,
    dto: CreateFlowNodeDto,
  ) {
    await this.findById(clinicId, flowId);

    return this.prisma.flowNode.create({
      data: {
        flowId,
        type: dto.type,
        label: dto.label,
        config: dto.config ?? {},
        position: dto.position,
      },
    });
  }

  async updateNode(
    clinicId: string,
    flowId: string,
    nodeId: string,
    dto: UpdateFlowNodeDto,
  ) {
    await this.findById(clinicId, flowId);
    const node = await this.prisma.flowNode.findFirst({
      where: { id: nodeId, flowId },
    });
    if (!node) throw new NotFoundException('Node not found in this flow');

    return this.prisma.flowNode.update({
      where: { id: nodeId },
      data: {
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.label !== undefined && { label: dto.label }),
        ...(dto.config !== undefined && { config: dto.config }),
        ...(dto.position !== undefined && { position: dto.position }),
      },
    });
  }

  async deleteNode(
    clinicId: string,
    flowId: string,
    nodeId: string,
  ): Promise<void> {
    await this.findById(clinicId, flowId);
    const node = await this.prisma.flowNode.findFirst({
      where: { id: nodeId, flowId },
    });
    if (!node) throw new NotFoundException('Node not found in this flow');
    await this.prisma.flowNode.delete({ where: { id: nodeId } });
  }

  async reorderNodes(
    clinicId: string,
    flowId: string,
    nodeIds: string[],
  ) {
    await this.findById(clinicId, flowId);
    const updates = nodeIds.map((id, index) =>
      this.prisma.flowNode.update({
        where: { id },
        data: { position: index },
      }),
    );
    await this.prisma.$transaction(updates);
    return this.prisma.flowNode.findMany({
      where: { flowId },
      orderBy: { position: 'asc' },
    });
  }
}
