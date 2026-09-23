UPDATE "BotMessage" SET "body" = 'What is your full name, as it appears in your clinic record?'
WHERE "key" = 'ASK_NAME' AND "language" = 'EN' AND "body" = 'What is your first name?';

UPDATE "BotMessage" SET "body" = 'Quels sont vos nom et prénom, tels qu''ils figurent dans votre dossier à la clinique ?'
WHERE "key" = 'ASK_NAME' AND "language" = 'FR' AND "body" = 'Quel est votre prénom ?';
