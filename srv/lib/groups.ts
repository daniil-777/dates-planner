/**
 * Accounts, households and the invitations that join them — TWM-ADR-002 phase 1.
 *
 * `srv/lib/auth.ts` answers "is this the right password"; this file answers "and whose
 * ledger is it". They are deliberately separate: a login is a person's credential and
 * exists once, while a `People` row is a seat at one household's table and exists once per
 * household they belong to. Conflating the two is what makes multi-tenancy hard to add
 * later, so it is not done here.
 *
 * Everything below writes through the *base tables*. These run before a session names a
 * group — that is the whole point of them — so they must not go through `LedgerService`,
 * whose every read is narrowed to a group the caller does not yet have.
 */
import cds from '@sap/cds'
import bcrypt from 'bcryptjs'
import { randomInt, timingSafeEqual } from 'node:crypto'

const { INSERT, SELECT, UPDATE } = cds.ql

const GROUPS = 'twowaymatch.Groups'
const USERS = 'twowaymatch.Users'
const MEMBERSHIPS = 'twowaymatch.Memberships'
const PEOPLE = 'twowaymatch.People'
const CONVERSATIONS = 'twowaymatch.Conversations'

/** Cost 12: about 250 ms on the Fly machine, which is the point of it. */
const BCRYPT_COST = 12

/**
 * Invite codes are read aloud and typed on phones, so the alphabet omits every pair that
 * looks alike in a sans-serif face: no O/0, no I/1/l, no B/8, no S/5, no Z/2.
 */
const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679'
const CODE_LENGTH = 8
const CODE_TTL_MS = 72 * 60 * 60 * 1000

/** The palette new people are coloured from — the category hues of CONTRACTS section 1.1. */
const PERSON_COLOURS = [
  '#0070F2',
  '#F31DED',
  '#049F9A',
  '#7858FF',
  '#C87200',
  '#256F3A',
  '#D20A0A',
  '#5B738B',
  '#A45D00',
  '#E76500',
] as const

export type GroupKind = 'couple' | 'household' | 'friends' | 'family' | 'other'
export type MemberRole = 'owner' | 'member'

export interface AccountRow {
  ID: string
  email: string
  displayName: string | null
}

export interface MembershipView {
  groupId: string
  groupName: string
  kind: GroupKind
  role: MemberRole
  personId: string
  personName: string
}

/** Anything the caller got wrong, with a message written for a person. */
export class GroupError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'GroupError'
    this.status = status
  }
}

/* ------------------------------------------------------------------ *
 *  Accounts
 * ------------------------------------------------------------------ */

/** Lower-cased and trimmed. Identity providers disagree about case; people do not. */
function normaliseEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function assertEmail(email: string): void {
  // Deliberately loose. The only address that matters is one the person can actually
  // receive at, and no regex establishes that; this rejects obvious typos and nothing more.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new GroupError(400, 'that does not look like an email address')
  }
}

function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 8) {
    throw new GroupError(400, 'choose a password of at least 8 characters')
  }
  if (password.length > 200) {
    throw new GroupError(400, 'that password is longer than 200 characters')
  }
}

/**
 * Create an account.
 *
 * A duplicate address is reported plainly rather than hidden. Account enumeration is a real
 * concern on a public service; this is a private ledger for a handful of households, and a
 * person who cannot be told "you already have an account" is a person who cannot get in.
 */
export async function registerUser(input: {
  email: unknown
  password: unknown
  displayName: unknown
}): Promise<AccountRow> {
  const email = normaliseEmail(input.email)
  assertEmail(email)
  assertPassword(input.password)

  const displayName =
    typeof input.displayName === 'string' && input.displayName.trim() !== ''
      ? input.displayName.trim().slice(0, 100)
      : email.split('@')[0]

  // `== null` on purpose, covering both: CAP's `SELECT.one` answers `undefined` for no
  // match, not `null`, and a strict `!== null` therefore reads every miss as a hit --
  // which made every single registration report a duplicate.
  const existing = (await SELECT.one.from(USERS).columns('ID').where({ email })) as
    { ID?: string } | null | undefined
  if (existing != null) throw new GroupError(409, 'there is already an account for that address')

  const ID = cds.utils.uuid()
  await INSERT.into(USERS).entries({
    ID,
    email,
    passwordHash: await bcrypt.hash(input.password, BCRYPT_COST),
    displayName,
  })
  return { ID, email, displayName }
}

/**
 * Check an email and password.
 *
 * Runs one bcrypt comparison whether or not the address exists, against a decoy hash of the
 * same cost, so "no such account" and "wrong password" take the same time as well as
 * returning the same answer. `srv/lib/auth.ts` does this for the configured logins and the
 * reasoning is identical.
 */
let decoyHash: string | null = null
export async function verifyUser(email: unknown, password: unknown): Promise<AccountRow | null> {
  const address = normaliseEmail(email)
  const offered = typeof password === 'string' ? password : ''

  const row = (await SELECT.one
    .from(USERS)
    .columns('ID', 'email', 'displayName', 'passwordHash')
    .where({ email: address })) as
    | { ID: string; email: string; displayName: string | null; passwordHash: string }
    | null
    | undefined

  decoyHash ??= await bcrypt.hash('there is no account with this address', BCRYPT_COST)
  const matched = await bcrypt.compare(offered, row?.passwordHash ?? decoyHash)
  if (row == null || !matched) return null
  return { ID: row.ID, email: row.email, displayName: row.displayName }
}

/* ------------------------------------------------------------------ *
 *  Households
 * ------------------------------------------------------------------ */

function newInviteCode(): string {
  let code = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  }
  return code
}

/** Case-insensitive, and constant-time so a code cannot be guessed character by character. */
function codesMatch(offered: string, stored: string): boolean {
  const a = Buffer.from(offered.trim().toUpperCase(), 'utf8')
  const b = Buffer.from(stored.trim().toUpperCase(), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** A colour no one in this household is using yet, falling back to the palette in order. */
async function nextColour(groupId: string): Promise<string> {
  const taken = new Set(
    (
      (await SELECT.from(PEOPLE).columns('colour').where({ group_ID: groupId })) as Array<{
        colour?: string | null
      }>
    ).map(row => String(row.colour ?? '').toUpperCase()),
  )
  return (
    PERSON_COLOURS.find(colour => !taken.has(colour.toUpperCase())) ??
    PERSON_COLOURS[taken.size % PERSON_COLOURS.length]
  )
}

/**
 * Give a user a seat in a household: a `People` row and the `Membership` that binds them.
 *
 * Shared by "create a household" and "join one", because the two differ only in the role
 * and in who made the group.
 */
async function seat(
  userId: string,
  groupId: string,
  displayName: string,
  role: MemberRole,
): Promise<{ personId: string; personName: string }> {
  const personId = cds.utils.uuid()
  await INSERT.into(PEOPLE).entries({
    ID: personId,
    group_ID: groupId,
    name: displayName,
    colour: await nextColour(groupId),
    // Never `true`, whatever the role. `People.isDefault` already means something else --
    // "a seeded member of the original household" -- and `LedgerService.viewer()` uses it
    // as the fallback for a request that names nobody. Marking a new owner default made
    // the first alphabetical owner answer for every anonymous request, which handed the
    // seeded household's screens to a stranger's group. Ownership lives on the
    // Membership, which is the only place that should know about it.
    isDefault: false,
  })
  await INSERT.into(MEMBERSHIPS).entries({
    ID: cds.utils.uuid(),
    user_ID: userId,
    group_ID: groupId,
    person_ID: personId,
    role,
  })
  return { personId, personName: displayName }
}

const KINDS: ReadonlySet<string> = new Set(['couple', 'household', 'friends', 'family', 'other'])

/**
 * Start a household. The creator becomes its owner and its first person, and the group's
 * one conversation is created with it so chat has somewhere to go from the first message.
 */
export async function createGroup(input: {
  userId: string
  displayName: string
  name: unknown
  kind: unknown
  currency?: unknown
}): Promise<MembershipView & { inviteCode: string }> {
  const name =
    typeof input.name === 'string' && input.name.trim() !== ''
      ? input.name.trim().slice(0, 120)
      : 'Our household'
  const kind = (
    typeof input.kind === 'string' && KINDS.has(input.kind) ? input.kind : 'couple'
  ) as GroupKind
  const currency =
    typeof input.currency === 'string' && /^[A-Za-z]{3}$/.test(input.currency)
      ? input.currency.toUpperCase()
      : 'CHF'

  const groupId = cds.utils.uuid()
  const inviteCode = newInviteCode()
  await INSERT.into(GROUPS).entries({
    ID: groupId,
    name,
    kind,
    currency,
    isDefault: false,
    inviteCode,
    inviteExpiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  })
  await INSERT.into(CONVERSATIONS).entries({
    ID: cds.utils.uuid(),
    group_ID: groupId,
    kind: 'group',
    title: name,
  })

  const person = await seat(input.userId, groupId, input.displayName, 'owner')
  return { groupId, groupName: name, kind, role: 'owner', inviteCode, ...person }
}

/**
 * Join a household with the code its owner was shown.
 *
 * The code is single-use in the sense that matters: it is rotated the moment somebody
 * joins, so a code shared in a group chat cannot keep letting people in. An owner who
 * wants two people to join asks for a new code, which is one tap.
 */
export async function joinGroup(input: {
  userId: string
  displayName: string
  code: unknown
}): Promise<MembershipView> {
  const offered = typeof input.code === 'string' ? input.code.trim() : ''
  if (offered.length !== CODE_LENGTH) {
    throw new GroupError(400, `an invitation code is ${CODE_LENGTH} characters`)
  }

  const candidates = (await SELECT.from(GROUPS).columns(
    'ID',
    'name',
    'kind',
    'inviteCode',
    'inviteExpiresAt',
  )) as Array<{
    ID: string
    name: string | null
    kind: string | null
    inviteCode: string | null
    inviteExpiresAt: string | null
  }>

  const group = candidates.find(
    row => typeof row.inviteCode === 'string' && codesMatch(offered, row.inviteCode),
  )
  // One message for "no such code" and "expired code" alike: a stranger trying codes
  // learns nothing from the difference, and a person who mistyped is told to ask again
  // either way.
  const expired = group?.inviteExpiresAt != null && Date.parse(group.inviteExpiresAt) < Date.now()
  if (group === undefined || expired) {
    throw new GroupError(404, 'that invitation code is not valid — ask for a fresh one')
  }

  const already = (await SELECT.one
    .from(MEMBERSHIPS)
    .columns('ID')
    .where({ user_ID: input.userId, group_ID: group.ID })) as { ID?: string } | null | undefined
  if (already != null) throw new GroupError(409, 'you are already in that household')

  const person = await seat(input.userId, String(group.ID), input.displayName, 'member')
  await rotateInvite(String(group.ID))

  return {
    groupId: String(group.ID),
    groupName: group.name ?? 'Our household',
    kind: (group.kind ?? 'couple') as GroupKind,
    role: 'member',
    ...person,
  }
}

/** Issue a fresh code, invalidating the old one. Returns what to show, once. */
export async function rotateInvite(groupId: string): Promise<{ code: string; expiresAt: string }> {
  const code = newInviteCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString()
  await UPDATE.entity(GROUPS).set({ inviteCode: code, inviteExpiresAt: expiresAt }).where({
    ID: groupId,
  })
  return { code, expiresAt }
}

/* ------------------------------------------------------------------ *
 *  Reading a user's memberships
 * ------------------------------------------------------------------ */

/** Every household this account belongs to, newest membership last. */
export async function membershipsOf(userId: string): Promise<MembershipView[]> {
  const rows = (await SELECT.from(MEMBERSHIPS)
    .columns('group_ID', 'person_ID', 'role')
    .where({ user_ID: userId })) as Array<{
    group_ID?: string | null
    person_ID?: string | null
    role?: string | null
  }>
  if (rows.length === 0) return []

  const views: MembershipView[] = []
  for (const row of rows) {
    if (row.group_ID == null || row.person_ID == null) continue
    const group = (await SELECT.one
      .from(GROUPS)
      .columns('ID', 'name', 'kind')
      .where({ ID: row.group_ID })) as
      { name?: string | null; kind?: string | null } | null | undefined
    const person = (await SELECT.one
      .from(PEOPLE)
      .columns('ID', 'name')
      .where({ ID: row.person_ID })) as { name?: string | null } | null | undefined
    if (group == null || person == null) continue // a household that was deleted
    views.push({
      groupId: String(row.group_ID),
      groupName: group.name ?? 'Our household',
      kind: (group.kind ?? 'couple') as GroupKind,
      role: (row.role === 'owner' ? 'owner' : 'member') as MemberRole,
      personId: String(row.person_ID),
      personName: person.name ?? '',
    })
  }
  return views
}

/** The membership a session's group claim points at, or the only one, or none. */
export async function resolveMembership(
  userId: string,
  groupId: string | null,
): Promise<MembershipView | null> {
  const all = await membershipsOf(userId)
  if (all.length === 0) return null
  if (groupId !== null) {
    const named = all.find(view => view.groupId === groupId)
    if (named !== undefined) return named
  }
  return all[0] ?? null
}

/** The current invitation for a household, minted if it has none or the old one has lapsed. */
export async function currentInvite(groupId: string): Promise<{ code: string; expiresAt: string }> {
  const row = (await SELECT.one
    .from(GROUPS)
    .columns('inviteCode', 'inviteExpiresAt')
    .where({ ID: groupId })) as
    { inviteCode?: string | null; inviteExpiresAt?: string | null } | null | undefined

  const lapsed = row?.inviteExpiresAt == null || Date.parse(row.inviteExpiresAt) < Date.now()
  if (row?.inviteCode == null || row.inviteCode === '' || lapsed) return rotateInvite(groupId)
  return { code: row.inviteCode, expiresAt: row.inviteExpiresAt as string }
}
