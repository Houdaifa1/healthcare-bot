import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FlowsService } from './flows.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { SessionsService, Session, SessionState } from '../sessions/sessions.service';
import { BotMessageService } from '../bot-content/bot-message.service';
import { SpecialtyService } from '../bot-content/specialty.service';
import { DoctorService } from '../bot-content/doctor.service';
import { AvailabilityService } from '../bot-content/availability.service';
import { LanguageDetectionService } from '../bot-content/language-detection.service';
import { AppointmentsService } from '../appointments/appointments.service';
import { NodeType, Language, MessageKey, Specialty } from '@prisma/client';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

@Injectable()
export class FlowEngineService {
  private readonly logger = new Logger(FlowEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flowsService: FlowsService,
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly botMessageService: BotMessageService,
    private readonly specialtyService: SpecialtyService,
    private readonly doctorService: DoctorService,
    private readonly availabilityService: AvailabilityService,
    private readonly languageDetectionService: LanguageDetectionService,
    private readonly appointmentsService: AppointmentsService,
  ) {}

  /**
   * Process an incoming user message using the active flow.
   * Returns true if the flow handled it, false if the user should fall through
   * to the old orchestrator (for backward compatibility).
   */
  async processMessage(
    phone: string,
    text: string,
    session: Session,
  ): Promise<boolean> {
    const clinicId = session.data.clinicId;
    const activeFlow = await this.flowsService.getActiveFlow(clinicId);

    // No active flow — let existing orchestrator handle it
    if (!activeFlow) {
      return false;
    }

    // Cast data to any to allow dynamic flow fields
    const data = session.data as any;

    // If session is in IDLE and language not confirmed, detect language first
    if (session.state as unknown as string === 'IDLE' && !session.data.languageConfirmed) {
      await this.handleLanguageDetection(phone, text, session, activeFlow);
      return true;
    }

    // If we're at IDLE but language is confirmed, start the flow from first node
    if (session.state as unknown as string === 'IDLE' && session.data.languageConfirmed) {
      return await this.startFlow(phone, session, activeFlow);
    }

    // If already IN_FLOW, route to the current node
    if (session.state as unknown as string === 'IN_FLOW' && data.flowId) {
      return await this.processCurrentNode(phone, text, session);
    }

    return false;
  }

  private async handleLanguageDetection(
    phone: string,
    text: string,
    session: Session,
    activeFlow: any,
  ): Promise<void> {
    const detected = await this.languageDetectionService.detect(
      text,
      session.data.language,
    );

    if (detected === null) {
      // Ambiguous — show language selection buttons
      session.state = SessionState.LANGUAGE_SELECT as any;
      await this.sessionsService.save(session);
      const message = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.LANGUAGE_PROMPT,
        {},
        session.data.language,
      );
      const btnFr = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.BUTTON_FRENCH,
        {},
        session.data.language,
      );
      const btnEn = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.BUTTON_ENGLISH,
        {},
        session.data.language,
      );
      await this.whatsappService.sendButtons(phone, message, [
        { id: 'lang_fr', title: btnFr },
        { id: 'lang_en', title: btnEn },
      ]);
      return;
    }

    session.data.language = detected as Language;
    session.data.languageConfirmed = true;
    await this.sessionsService.save(session);

    // After detection, start the flow
    await this.startFlow(phone, session, activeFlow);
  }

  private async startFlow(
    phone: string,
    session: Session,
    activeFlow: any,
  ): Promise<boolean> {
    if (activeFlow.nodes.length === 0) return false;

    const firstNode = activeFlow.nodes[0];

    // Update session to flow-based state
    (session.state as any) = 'IN_FLOW';
    (session.data as any).flowId = activeFlow.id;
    (session.data as any).currentNodeId = firstNode.id;
    await this.sessionsService.save(session);

    await this.executeNode(phone, session, firstNode);
    return true;
  }

  private async processCurrentNode(
    phone: string,
    text: string,
    session: Session,
  ): Promise<boolean> {
    const data = session.data as any;
    if (!data.currentNodeId || !data.flowId) return false;

    const node = await (this.prisma as any).flowNode.findUnique({
      where: { id: data.currentNodeId },
    });
    if (!node) return false;

    const nextNode = await this.handleNodeInput(phone, text, session, node);
    if (nextNode) {
      data.currentNodeId = nextNode.id;
      await this.sessionsService.save(session);
      await this.executeNode(phone, session, nextNode);
    }
    return true;
  }

  /**
   * Execute a node — send the appropriate WhatsApp message based on node type.
   */
  async executeNode(phone: string, session: Session, node: any): Promise<void> {
    const lang = session.data.language;
    const collected = session.data as any;

    switch (node.type) {
      case NodeType.TEXT:
        await this.handleTextNode(phone, node, lang, collected);
        break;
      case NodeType.BUTTONS:
        await this.handleButtonsNode(phone, node, lang, collected);
        break;
      case NodeType.LIST:
        await this.handleListNode(phone, node, lang, collected);
        break;
      case NodeType.SPECIALTY_LIST:
        await this.handleSpecialtyListNode(phone, session, node, lang);
        break;
      case NodeType.DOCTOR_LIST:
        await this.handleDoctorListNode(phone, session, node, lang);
        break;
      case NodeType.DATE_PICKER:
        await this.handleDatePickerNode(phone, session, node, lang);
        break;
      case NodeType.TIME_PICKER:
        await this.handleTimePickerNode(phone, session, node, lang);
        break;
      case NodeType.FREE_TEXT_INPUT:
        await this.handleFreeTextInputNode(phone, node, lang, collected);
        break;
      case NodeType.BOOK_APPOINTMENT:
        await this.handleBookAppointmentNode(phone, session, node, lang);
        break;
      case NodeType.END:
        await this.handleEndNode(phone, node, lang, collected);
        break;
      default:
        this.logger.warn(`Unknown node type: ${node.type}`);
    }
  }

  /**
   * Handle user input for a node — validate and return the next node.
   */
  private async handleNodeInput(
    phone: string,
    text: string,
    session: Session,
    node: any,
  ): Promise<any | null> {
    const config = node.config as Record<string, any>;

    switch (node.type) {
      case NodeType.FREE_TEXT_INPUT: {
        const varName = config.variableName || 'free_text';
        if (!text || text.trim().length < (config.minLength || 1)) {
          // Re-prompt
          await this.executeNode(phone, session, node);
          return null;
        }
        (session.data as any)[varName] = text.trim();
        await this.sessionsService.save(session);
        return this.findNodeById(node.flowId, config.nextNodeId || node.position + 1);
      }

      case NodeType.BUTTONS: {
        const buttons = config.buttons || [];
        const matched = buttons.find((b: any) => b.id === text);
        if (matched) {
          return this.findNodeById(node.flowId, matched.nextNodeId);
        }
        // Invalid selection — re-prompt
        await this.executeNode(phone, session, node);
        return null;
      }

      case NodeType.LIST: {
        const rows = config.rows || [];
        const matched = rows.find((r: any) => r.id === text);
        if (matched) {
          return this.findNodeById(node.flowId, matched.nextNodeId);
        }
        await this.executeNode(phone, session, node);
        return null;
      }

      case NodeType.SPECIALTY_LIST: {
        const specialties = await this.specialtyService.findActive(
          session.data.clinicId,
          session.data.language,
        );
        const specialty = resolveSpecialty(text, specialties);
        if (!specialty) {
          await this.executeNode(phone, session, node);
          return null;
        }
        session.data.specialtyId = specialty.id;
        await this.sessionsService.save(session);
        return this.findNodeById(node.flowId, config.nextNodeId || node.position + 1);
      }

      case NodeType.DOCTOR_LIST: {
        const specialtyId = config.filterBySpecialty
          ? session.data.specialtyId
          : undefined;
        const doctors = await this.doctorService.findBySpecialty(
          session.data.clinicId,
          specialtyId || config.specialtyId || '',
        );
        const doctor = resolveDoctor(text, doctors);
        if (!doctor) {
          await this.executeNode(phone, session, node);
          return null;
        }
        session.data.doctorId = doctor.id;
        await this.sessionsService.save(session);
        return this.findNodeById(node.flowId, config.nextNodeId || node.position + 1);
      }

      case NodeType.DATE_PICKER: {
        const dateMatch = text.match(/date_(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          session.data.selectedDate = dateMatch[1];
          await this.sessionsService.save(session);
          return this.findNodeById(node.flowId, config.nextNodeId || node.position + 1);
        }
        await this.executeNode(phone, session, node);
        return null;
      }

      case NodeType.TIME_PICKER: {
        const timeMatch = text.match(/time_(\d{2}:\d{2})/);
        if (timeMatch) {
          session.data.selectedTime = timeMatch[1];
          await this.sessionsService.save(session);
          return this.findNodeById(node.flowId, config.nextNodeId || node.position + 1);
        }
        await this.executeNode(phone, session, node);
        return null;
      }

      case NodeType.CONDITION: {
        const variable = config.variable;
        const value = (session.data as any)[variable];
        const branches = config.branches || [];
        const matchedBranch = branches.find(
          (b: any) => b.value === value || b.value === '*',
        );
        if (matchedBranch) {
          return this.findNodeById(node.flowId, matchedBranch.nextNodeId);
        }
        return this.findNodeById(node.flowId, config.defaultNextNodeId);
      }

      default:
        // For TEXT and other auto-advance types, just go to next node
        return this.findNodeById(node.flowId, config.nextNodeId || node.position + 1);
    }
  }

  // ─── Node type handlers ─────────────────────────────────────────────────

  private async handleTextNode(
    phone: string,
    node: any,
    lang: Language,
    collected: any,
  ): Promise<void> {
    const config = node.config as Record<string, any>;
    const body = await this.resolveMessage(config.body || '', lang, collected);
    await this.whatsappService.sendText(phone, body);
  }

  private async handleButtonsNode(
    phone: string,
    node: any,
    lang: Language,
    collected: any,
  ): Promise<void> {
    const config = node.config as Record<string, any>;
    const body = await this.resolveMessage(config.body || '', lang, collected);
    const buttons = (config.buttons || []).map((b: any) => ({
      id: b.id,
      title: b.title,
    }));
    await this.whatsappService.sendButtons(phone, body, buttons);
  }

  private async handleListNode(
    phone: string,
    node: any,
    lang: Language,
    collected: any,
  ): Promise<void> {
    const config = node.config as Record<string, any>;
    const body = await this.resolveMessage(config.body || '', lang, collected);
    const header = await this.resolveMessage(config.header || '', lang, collected);
    const buttonLabel = config.buttonLabel || 'Select';

    await this.whatsappService.sendInteractiveList(
      phone,
      header,
      body,
      buttonLabel,
      [
        {
          title: config.sectionTitle || '',
          rows: (config.rows || []).map((r: any) => ({
            id: r.id,
            title: r.title,
            description: r.description,
          })),
        },
      ],
    );
  }

  private async handleSpecialtyListNode(
    phone: string,
    session: Session,
    node: any,
    lang: Language,
  ): Promise<void> {
    const config = node.config as Record<string, any>;
    const specialties = await this.specialtyService.findActive(
      session.data.clinicId,
      lang,
    );

    if (specialties.length === 0) {
      const fallback = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.FALLBACK,
        {},
        lang,
      );
      await this.whatsappService.sendText(phone, fallback);
      return;
    }

    const body = config.body || 'Select a specialty:';
    const header = config.header || 'Specialties';

    await this.whatsappService.sendInteractiveList(
      phone,
      header,
      body,
      header,
      [
        {
          title: '',
          rows: specialties.map((s) => ({
            id: `specialty_${s.slug}`,
            title: s.label,
          })),
        },
      ],
    );
  }

  private async handleDoctorListNode(
    phone: string,
    session: Session,
    node: any,
    lang: Language,
  ): Promise<void> {
    const config = node.config as Record<string, any>;
    const filterBySpecialty = config.filterBySpecialty !== false;
    const specialtyId = filterBySpecialty
      ? session.data.specialtyId
      : config.specialtyId || '';

    if (!specialtyId) {
      const fallback = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.FALLBACK,
        {},
        lang,
      );
      await this.whatsappService.sendText(phone, fallback);
      return;
    }

    const doctors = await this.doctorService.findBySpecialty(
      session.data.clinicId,
      specialtyId,
    );

    if (doctors.length === 0) {
      const fallback = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.FALLBACK,
        {},
        lang,
      );
      await this.whatsappService.sendText(phone, fallback);
      return;
    }

    const body = config.body || 'Select a doctor:';
    const header = config.header || 'Doctors';

    await this.whatsappService.sendInteractiveList(
      phone,
      header,
      body,
      header,
      [
        {
          title: header,
          rows: doctors.map((d) => ({
            id: `doctor_${d.id}`,
            title: d.name,
          })),
        },
      ],
    );
  }

  private async handleDatePickerNode(
    phone: string,
    session: Session,
    node: any,
    lang: Language,
  ): Promise<void> {
    const config = node.config as Record<string, any>;
    const doctorId = session.data.doctorId || config.doctorId;

    if (!doctorId) {
      const fallback = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.FALLBACK,
        {},
        lang,
      );
      await this.whatsappService.sendText(phone, fallback);
      return;
    }

    const availableDates = await this.availabilityService.getAvailableDates(
      doctorId,
      config.maxDates || 5,
    );

    if (availableDates.length === 0) {
      const message = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.NO_SLOTS_AVAILABLE,
        {},
        lang,
      );
      await this.whatsappService.sendText(phone, message);
      return;
    }

    const body = config.body || 'Select a date:';

    await this.whatsappService.sendButtons(
      phone,
      body,
      availableDates.map((date) => {
        const d = new Date(date);
        const label = format(d, 'eeee dd MMMM', {
          locale: lang === 'FR' ? fr : undefined,
        });
        return {
          id: `date_${date}`,
          title: label.charAt(0).toUpperCase() + label.slice(1),
        };
      }),
    );
  }

  private async handleTimePickerNode(
    phone: string,
    session: Session,
    node: any,
    lang: Language,
  ): Promise<void> {
    const config = node.config as Record<string, any>;
    const doctorId = session.data.doctorId || config.doctorId;
    const date = session.data.selectedDate || config.date;

    if (!doctorId || !date) {
      const fallback = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.FALLBACK,
        {},
        lang,
      );
      await this.whatsappService.sendText(phone, fallback);
      return;
    }

    const availableSlots = await this.availabilityService.getAvailableSlots(
      doctorId,
      date,
    );

    if (availableSlots.length === 0) {
      const message = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.NO_SLOTS_AVAILABLE,
        {},
        lang,
      );
      await this.whatsappService.sendText(phone, message);
      return;
    }

    const header = config.header || 'Available times';
    const body = config.body || 'Select a time:';

    // Chunk into groups of 10 for list messages
    const chunkSize = 10;
    const sections = [];
    for (let i = 0; i < availableSlots.length; i += chunkSize) {
      const chunk = availableSlots.slice(i, i + chunkSize);
      sections.push({
        title: '',
        rows: chunk.map((time) => ({
          id: `time_${time}`,
          title: time,
        })),
      });
    }

    await this.whatsappService.sendInteractiveList(
      phone,
      header,
      body,
      header,
      sections,
    );
  }

  private async handleFreeTextInputNode(
    phone: string,
    node: any,
    lang: Language,
    collected: any,
  ): Promise<void> {
    const config = node.config as Record<string, any>;
    const body = await this.resolveMessage(config.body || '', lang, collected);
    await this.whatsappService.sendText(phone, body);
  }

  private async handleBookAppointmentNode(
    phone: string,
    session: Session,
    node: any,
    lang: Language,
  ): Promise<void> {
    const config = node.config as Record<string, any>;

    const doctorId = session.data.doctorId || config.doctorId;
    const specialtyId = session.data.specialtyId || config.specialtyId;
    const patientName = session.data.patientName || config.patientName || 'Patient';
    const selectedDate = session.data.selectedDate || config.date;
    const selectedTime = session.data.selectedTime || config.time;

    // Validate required fields
    if (!doctorId || !specialtyId || !selectedDate || !selectedTime) {
      const msg = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.ERROR_MISSING_INFO,
        {},
        lang,
      );
      await this.whatsappService.sendText(phone, msg);
      return;
    }

    const cleanPhone = phone.replace(/@(lid|s\.whatsapp\.net)$/, '');

    try {
      await this.appointmentsService.createAppointment(session.data.clinicId, {
        clinicId: session.data.clinicId,
        doctorId,
        specialtyId,
        patientName,
        patientPhone: cleanPhone,
        appointmentDate: selectedDate,
        appointmentTime: selectedTime,
      });

      const doctor = await this.doctorService.findById(doctorId);
      const successMessage = config.successMessage || 'Appointment booked successfully!';
      const message = await this.resolveMessage(successMessage, lang, {
        ...session.data,
        doctorName: doctor?.name || 'Doctor',
      });
      await this.whatsappService.sendText(phone, message);
    } catch (error) {
      this.logger.error(`Failed to book appointment: ${error.message}`);
      const msg = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.FALLBACK,
        {},
        lang,
      );
      await this.whatsappService.sendText(phone, msg);
    }

    // Reset session after booking
    await this.sessionsService.reset(phone);
  }

  private async handleEndNode(
    phone: string,
    node: any,
    lang: Language,
    collected: any,
  ): Promise<void> {
    const config = node.config as Record<string, any>;
    if (config.body) {
      const body = await this.resolveMessage(config.body, lang, collected);
      await this.whatsappService.sendText(phone, body);
    }
    await this.sessionsService.reset(phone);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async resolveMessage(
    template: string,
    lang: Language,
    vars: Record<string, any>,
  ): Promise<string> {
    if (template.startsWith('{{') && template.endsWith('}}')) {
      // It's a MessageKey reference — look up from bot_messages
      const key = template.replace(/[{}]/g, '') as MessageKey;
      try {
        return await this.botMessageService.get(
          vars.clinicId || 'main',
          key,
          vars,
          lang,
        );
      } catch {
        return template;
      }
    }
    // Resolve {{variables}} in the template
    let resolved = template;
    for (const [k, v] of Object.entries(vars)) {
      resolved = resolved.replaceAll(`{{${k}}}`, String(v ?? ''));
    }
    return resolved;
  }

  private findNodeById(flowId: string, targetPositionOrId: number | string): any {
    if (typeof targetPositionOrId === 'number') {
      return { flowId, position: targetPositionOrId, id: `pos_${targetPositionOrId}` };
    }
    return { flowId, id: targetPositionOrId };
  }
}

/**
 * Resolve specialty from user input.
 */
function resolveSpecialty(
  text: string,
  specialties: Specialty[],
): Specialty | null {
  const trimmed = text.trim();

  if (trimmed.startsWith('specialty_')) {
    const slug = trimmed.replace('specialty_', '');
    return specialties.find((s) => s.slug === slug) ?? null;
  }

  const index = parseInt(trimmed, 10);
  if (!isNaN(index) && index >= 1 && index <= specialties.length) {
    return specialties[index - 1];
  }

  const normalised = trimmed.toLowerCase();
  return specialties.find((s) => s.label.toLowerCase() === normalised) ?? null;
}

/**
 * Resolve doctor from user input.
 */
function resolveDoctor(text: string, doctors: any[]): any | null {
  const trimmed = text.trim();

  if (trimmed.startsWith('doctor_')) {
    const id = trimmed.replace('doctor_', '');
    return doctors.find((d) => d.id === id) ?? null;
  }

  const index = parseInt(trimmed, 10);
  if (!isNaN(index) && index >= 1 && index <= doctors.length) {
    return doctors[index - 1];
  }

  const normalised = trimmed.toLowerCase();
  return doctors.find((d) => d.name.toLowerCase() === normalised) ?? null;
}