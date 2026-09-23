UPDATE "BotMessage" SET "body" = '📋 Appointment request:
👤 {{patientName}}
👨‍⚕️ {{doctorName}}
📅 {{date}} at {{time}}

Send this request to our team?'
WHERE "key" = 'CONFIRM_BOOKING' AND "language" = 'EN'
  AND "body" = E'📋 Summary:\n👤 {{patientName}}\n👨‍⚕️ {{doctorName}}\n📅 {{date}} at {{time}}\n\nConfirm?';

UPDATE "BotMessage" SET "body" = '📋 Demande de rendez-vous :
👤 {{patientName}}
👨‍⚕️ {{doctorName}}
📅 {{date}} à {{time}}

Envoyer cette demande à notre équipe ?'
WHERE "key" = 'CONFIRM_BOOKING' AND "language" = 'FR'
  AND "body" = E'📋 Récapitulatif :\n👤 {{patientName}}\n👨‍⚕️ {{doctorName}}\n📅 {{date}} à {{time}}\n\nConfirmez-vous ?';

UPDATE "BotMessage" SET "body" = 'This booking request was stopped. Any existing appointment remains unchanged.'
WHERE "key" = 'BOOKING_CANCELLED' AND "language" = 'EN'
  AND "body" = '❌ Appointment cancelled. See you soon!';

UPDATE "BotMessage" SET "body" = 'Cette demande de rendez-vous a été arrêtée. Tout rendez-vous existant reste inchangé.'
WHERE "key" = 'BOOKING_CANCELLED' AND "language" = 'FR'
  AND "body" = '❌ Rendez-vous annulé. À bientôt !';
