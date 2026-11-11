import type { Tool } from "./define.ts";
import { listMailboxes } from "./mailboxes.ts";
import { getEmail, getThread, listIdentities, searchEmails } from "./mail.ts";

export const tools: Tool[] = [
  listMailboxes,
  searchEmails,
  getEmail,
  getThread,
  listIdentities,
];
