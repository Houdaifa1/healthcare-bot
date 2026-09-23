import { MessageProcessor } from './message.processor';

describe('inbound opt-out', () => {
  it('persists suppression before acknowledging processing and never routes STOP to the model', async () => {
    const sessions: any = {
      claimMessage: jest.fn().mockResolvedValue({ state: 'claimed', token: 'claim-1' }),
      completeMessage: jest.fn(), releaseMessage: jest.fn(),
      getCampaignSession: jest.fn().mockResolvedValue(null),
    };
    const prisma: any = {
      clinic: { findFirst: jest.fn().mockResolvedValue({ id: 'clinic-1' }) },
      contactSuppression: { upsert: jest.fn().mockResolvedValue({ id: 'suppression-1' }),
        findUnique: jest.fn().mockResolvedValue(null) },
    };
    const orchestrator: any = { handleMessage: jest.fn() };
    const conversation: any = { handleReply: jest.fn() };
    const processor = new MessageProcessor(orchestrator, sessions, prisma, conversation, {} as any, {} as any);
    await processor.process({ data: { messageId: 'wamid-1', from: '212600000001',
      name: 'Test', text: 'STOP', timestamp: '0' } } as any);

    expect(prisma.contactSuppression.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ clinicId: 'clinic-1', phoneNormalized: '212600000001' }),
    }));
    expect(prisma.contactSuppression.upsert.mock.invocationCallOrder[0])
      .toBeLessThan(sessions.completeMessage.mock.invocationCallOrder[0]);
    expect(orchestrator.handleMessage).not.toHaveBeenCalled();
    expect(conversation.handleReply).not.toHaveBeenCalled();
  });

  it('does not send automated responses after a persistent opt-out', async () => {
    const sessions: any = {
      claimMessage: jest.fn().mockResolvedValue({ state: 'claimed', token: 'claim-2' }),
      completeMessage: jest.fn(), releaseMessage: jest.fn(),
    };
    const prisma: any = {
      clinic: { findFirst: jest.fn().mockResolvedValue({ id: 'clinic-1' }) },
      contactSuppression: { findUnique: jest.fn().mockResolvedValue({ id: 'suppression-1' }) },
    };
    const orchestrator: any = { handleMessage: jest.fn() };
    const processor = new MessageProcessor(orchestrator, sessions, prisma, {} as any, {} as any, {} as any);
    await processor.process({ data: { messageId: 'wamid-2', from: '212600000001',
      name: 'Test', text: 'Hello', timestamp: '0' } } as any);
    expect(orchestrator.handleMessage).not.toHaveBeenCalled();
    expect(sessions.completeMessage).toHaveBeenCalled();
  });
});
