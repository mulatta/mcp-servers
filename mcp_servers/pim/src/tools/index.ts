import { getEvent, listCalendars, searchEvents } from "./calendar.ts";
import { getContact, listAddressBooks, searchContacts } from "./contacts.ts";
import type { Tool } from "./define.ts";
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
import { getSieveScript, getVacation, listSieveScripts } from "./settings.ts";

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
];
