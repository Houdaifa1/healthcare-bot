import { HandoffService } from './handoff.service';
import { BotMessagesController } from '@operations/clinic/bot-messages/bot-messages.controller';

describe('clinic boundaries', () => {
  it('limits active handoff listing to the authenticated clinic', async () => {
    const prisma = { handoff: { findMany: jest.fn().mockResolvedValue([]) } } as any;
    const service = new HandoffService({} as any, {} as any, prisma);
    await service.getHandoffSessions('clinic-a');
    expect(prisma.handoff.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ clinicId: 'clinic-a' }),
    }));
  });

  it('does not send a staff message to a handoff in another clinic', async () => {
    const prisma = { handoff: { findFirst: jest.fn().mockResolvedValue(null) } } as any;
    const whatsapp = { sendText: jest.fn() } as any;
    const service = new HandoffService({} as any, whatsapp, prisma);
    await expect(service.sendMessage('clinic-a', '212600000001', 'Hello')).rejects.toThrow('No active handoff');
    expect(prisma.handoff.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ clinicId: 'clinic-a' }),
    }));
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('refuses bot message access for a different clinic', () => {
    const service = { getMessages: jest.fn() } as any;
    const controller = new BotMessagesController(service);
    expect(() => controller.getMessages({ clinicId: 'clinic-a' } as any, 'clinic-b'))
      .toThrow('Clinic access denied');
    expect(service.getMessages).not.toHaveBeenCalled();
  });
});
