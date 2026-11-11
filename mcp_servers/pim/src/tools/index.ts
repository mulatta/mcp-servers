import { getEvent, listCalendars, searchEvents } from "./calendar.ts";
import { createEvent, deleteEvent, updateEvent } from "./calendar-write.ts";
import {
  createContact,
  deleteContact,
  updateContact,
} from "./contact-write.ts";
import { getContact, listAddressBooks, searchContacts } from "./contacts.ts";
import type { Tool } from "./define.ts";
import {
  createDraft,
  deleteDraft,
  sendDraft,
  sendEmail,
  updateDraft,
} from "./drafts.ts";
import { listMailboxes } from "./mailboxes.ts";
import {
  addEmailsToMailbox,
  createMailbox,
  deleteMailbox,
  destroyEmails,
  moveEmails,
  removeEmailsFromMailbox,
  setEmailFlags,
  trashEmails,
  updateMailbox,
} from "./mail-write.ts";
import { getEmail, getThread, listIdentities, searchEmails } from "./mail.ts";
import {
  activateSieveScript,
  deleteSieveScript,
  getSieveScript,
  getVacation,
  listSieveScripts,
  saveSieveScript,
  setVacation,
  validateSieveScript,
} from "./settings.ts";

export const tools: Tool[] = [
  listMailboxes,
  searchEmails,
  getEmail,
  getThread,
  listIdentities,
  listCalendars,
  searchEvents,
  getEvent,
  listAddressBooks,
  searchContacts,
  getContact,
  getVacation,
  listSieveScripts,
  getSieveScript,
  setEmailFlags,
  moveEmails,
  addEmailsToMailbox,
  removeEmailsFromMailbox,
  createMailbox,
  updateMailbox,
  deleteMailbox,
  trashEmails,
  destroyEmails,
  createDraft,
  updateDraft,
  deleteDraft,
  sendDraft,
  sendEmail,
  validateSieveScript,
  saveSieveScript,
  activateSieveScript,
  deleteSieveScript,
  setVacation,
  createEvent,
  updateEvent,
  deleteEvent,
  createContact,
  updateContact,
  deleteContact,
];
