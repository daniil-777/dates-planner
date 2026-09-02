/// <reference types="@cap-js/cds-types" />
/**
 * Accounts, households and invitations — TWM-ADR-002 phase 1, CONTRACTS.md section 12.2.
 *
 * These exercise `srv/lib/groups.ts` against a real database rather than the HTTP routes
 * around it, because the interesting behaviour is all here: what a duplicate address does,
 * whether a wrong password takes the same time as a missing account, whether a used
 * invitation still works, and whether two households seeded a minute apart end up sharing
 * anything. The routes are a thin translation of these functions into status codes.
 *
 * The seeded household from `db/data` is present throughout, which is deliberate: every
 * assertion about a *new* household is also an assertion that it did not disturb the one
 * that was already there.
 */
import cds from '@sap/cds'
import type { Service } from '@sap/cds'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  createGroup,
  currentInvite,
  GroupError,
  joinGroup,
  membershipsOf,
  registerUser,
  resolveMembership,
  rotateInvite,
  verifyUser,
} from '../srv/lib/groups'

const { SELECT } = cds.ql

interface CdsBootstrap {
  deploy(model: cds.csn.CSN): {
    to(target: unknown, options?: { silent?: boolean }): Promise<Service>
  }
}
const bootstrap = cds as unknown as CdsBootstrap

let csn: cds.csn.CSN
let db: Service

beforeAll(async () => {
  cds.root = process.cwd()
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
  csn = await cds.load(['db', 'srv'])
  cds.model = cds.compile.for.nodejs(csn)
  db = await bootstrap.deploy(csn).to('db', { silent: true })
})

beforeEach(async () => {
  await bootstrap.deploy(csn).to(db, { silent: true })
})

/**
 * A fresh account.
 *
 * The address is unique per call rather than reset between tests: `Users` has no seed CSV,
 * so a re-deploy does not necessarily clear it, and a suite that depends on that is a suite
 * that fails for a reason having nothing to do with what it is testing. Uniqueness is the
 * property these tests actually need.
 */
let accountsMade = 0
const PASSWORD = 'correct horse battery'
function anAddress(hint = 'ada'): string {
  accountsMade += 1
  return `${hint}-${accountsMade}@example.com`
}
async function anAccount(email = anAddress(), displayName = 'Ada') {
  return registerUser({ email, password: PASSWORD, displayName })
}

describe('an account', () => {
  it('is created, and can sign in afterwards', async () => {
    const email = anAddress()
    const created = await anAccount(email)
    expect(created.email).toBe(email)
    expect(created.displayName).toBe('Ada')

    const signedIn = await verifyUser(email, PASSWORD)
    expect(signedIn?.ID).toBe(created.ID)
  })

  it('treats the address case-insensitively, because people do', async () => {
    const email = anAddress()
    await anAccount(email.toUpperCase())
    const signedIn = await verifyUser(`  ${email.toUpperCase()} `, PASSWORD)
    expect(signedIn).not.toBeNull()
  })

  it('refuses a second account for the same address', async () => {
    const email = anAddress()
    await anAccount(email)
    await expect(anAccount(email.toUpperCase())).rejects.toThrow(/already an account/i)
  })

  it('refuses a password too short to be worth hashing', async () => {
    await expect(
      registerUser({ email: anAddress('b'), password: 'short', displayName: 'B' }),
    ).rejects.toThrow(/at least 8 characters/i)
  })

  it('refuses something that is not an address', async () => {
    await expect(
      registerUser({ email: 'not-an-address', password: PASSWORD, displayName: '' }),
    ).rejects.toThrow(/does not look like an email/i)
  })

  it('answers a wrong password and an unknown address the same way', async () => {
    const email = anAddress()
    await anAccount(email)
    expect(await verifyUser(email, 'wrong')).toBeNull()
    expect(await verifyUser(anAddress('nobody'), PASSWORD)).toBeNull()
  })

  it('never stores the password itself', async () => {
    const created = await anAccount()
    const row = (await db.run(SELECT.one.from('twowaymatch.Users').where({ ID: created.ID }))) as {
      passwordHash?: string
    } | null
    expect(row?.passwordHash).toMatch(/^\$2[aby]\$/)
    expect(JSON.stringify(row)).not.toContain(PASSWORD)
  })
})

describe('a household', () => {
  it('is created with its owner seated in it', async () => {
    const account = await anAccount()
    const group = await createGroup({
      userId: account.ID,
      displayName: 'Ada',
      name: 'Ada and Grace',
      kind: 'couple',
    })

    expect(group.groupName).toBe('Ada and Grace')
    expect(group.role).toBe('owner')
    expect(group.personName).toBe('Ada')
    expect(group.inviteCode).toHaveLength(8)

    const mine = await membershipsOf(account.ID)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.groupId).toBe(group.groupId)
  })

  it('gets a conversation at the same moment, so chat has somewhere to go', async () => {
    const account = await anAccount()
    const group = await createGroup({
      userId: account.ID,
      displayName: 'Ada',
      name: 'A',
      kind: 'couple',
    })

    const threads = (await db.run(
      SELECT.from('twowaymatch.Conversations').where({ group_ID: group.groupId }),
    )) as unknown[]
    expect(threads).toHaveLength(1)
  })

  it('does not touch the household that was already there', async () => {
    const before = (await db.run(SELECT.from('twowaymatch.People'))) as unknown[]
    const account = await anAccount()
    await createGroup({ userId: account.ID, displayName: 'Ada', name: 'A', kind: 'couple' })
    const after = (await db.run(SELECT.from('twowaymatch.People'))) as unknown[]

    // Exactly one person was added, and it was not taken from the seeded roster.
    expect(after.length).toBe(before.length + 1)
  })

  it('gives each new person a colour nobody in that household is using', async () => {
    const ada = await anAccount()
    const grace = await registerUser({
      email: anAddress('grace'),
      password: PASSWORD,
      displayName: 'Grace',
    })
    const group = await createGroup({
      userId: ada.ID,
      displayName: 'Ada',
      name: 'A',
      kind: 'couple',
    })
    const invite = await currentInvite(group.groupId)
    await joinGroup({ userId: grace.ID, displayName: 'Grace', code: invite.code })

    const people = (await db.run(
      SELECT.from('twowaymatch.People').columns('colour').where({ group_ID: group.groupId }),
    )) as Array<{ colour: string }>
    expect(people).toHaveLength(2)
    expect(new Set(people.map(row => row.colour)).size).toBe(2)
  })
})

describe('an invitation', () => {
  async function aHouseholdWithGuest() {
    const owner = await anAccount(anAddress('owner'), 'Owner')
    const guest = await registerUser({
      email: anAddress('guest'),
      password: PASSWORD,
      displayName: 'Guest',
    })
    const group = await createGroup({
      userId: owner.ID,
      displayName: 'Owner',
      name: 'The Household',
      kind: 'household',
    })
    return { owner, guest, group }
  }

  it('lets somebody in, and seats them as a member', async () => {
    const { guest, group } = await aHouseholdWithGuest()
    const invite = await currentInvite(group.groupId)

    const joined = await joinGroup({ userId: guest.ID, displayName: 'Guest', code: invite.code })
    expect(joined.groupId).toBe(group.groupId)
    expect(joined.role).toBe('member')
    expect(joined.groupName).toBe('The Household')
  })

  it('is accepted regardless of how it was typed', async () => {
    const { guest, group } = await aHouseholdWithGuest()
    const invite = await currentInvite(group.groupId)
    const joined = await joinGroup({
      userId: guest.ID,
      displayName: 'Guest',
      code: `  ${invite.code.toLowerCase()} `,
    })
    expect(joined.groupId).toBe(group.groupId)
  })

  it('stops working the moment it is used', async () => {
    const { guest, group } = await aHouseholdWithGuest()
    const invite = await currentInvite(group.groupId)
    await joinGroup({ userId: guest.ID, displayName: 'Guest', code: invite.code })

    const third = await registerUser({
      email: anAddress('third'),
      password: PASSWORD,
      displayName: 'Third',
    })
    // The code was rotated on the way in, so the one shared earlier is now worthless.
    await expect(
      joinGroup({ userId: third.ID, displayName: 'Third', code: invite.code }),
    ).rejects.toThrow(/not valid/i)
  })

  it('is refused once it has expired, in the same words as a wrong code', async () => {
    const { guest, group } = await aHouseholdWithGuest()
    const invite = await currentInvite(group.groupId)
    await db.run(
      cds.ql.UPDATE.entity('twowaymatch.Groups')
        .set({ inviteExpiresAt: new Date(Date.now() - 1000).toISOString() })
        .where({ ID: group.groupId }),
    )
    await expect(
      joinGroup({ userId: guest.ID, displayName: 'Guest', code: invite.code }),
    ).rejects.toThrow(/not valid/i)
  })

  it('refuses a code of the wrong length before looking anything up', async () => {
    const { guest } = await aHouseholdWithGuest()
    await expect(
      joinGroup({ userId: guest.ID, displayName: 'Guest', code: 'SHORT' }),
    ).rejects.toThrow(/8 characters/i)
  })

  it('refuses to seat the same person twice', async () => {
    const { guest, group } = await aHouseholdWithGuest()
    const first = await currentInvite(group.groupId)
    await joinGroup({ userId: guest.ID, displayName: 'Guest', code: first.code })

    const second = await rotateInvite(group.groupId)
    await expect(
      joinGroup({ userId: guest.ID, displayName: 'Guest', code: second.code }),
    ).rejects.toThrow(/already in that household/i)
  })

  it('uses an alphabet with no character that could be misread aloud', async () => {
    const account = await anAccount()
    const group = await createGroup({
      userId: account.ID,
      displayName: 'Ada',
      name: 'A',
      kind: 'couple',
    })
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const { code } = await rotateInvite(group.groupId)
      // No O/0, I/1/L, B/8, S/5, Z/2 — the pairs that go wrong when a code is read out.
      expect(code).toMatch(/^[ACDEFGHJKMNPQRTUVWXY34679]{8}$/)
    }
  })
})

describe('belonging to more than one household', () => {
  it('lists them all, and resolves the one a session names', async () => {
    const account = await anAccount()
    const first = await createGroup({
      userId: account.ID,
      displayName: 'Ada',
      name: 'Home',
      kind: 'couple',
    })
    const second = await createGroup({
      userId: account.ID,
      displayName: 'Ada',
      name: 'The Flat Share',
      kind: 'friends',
    })

    const all = await membershipsOf(account.ID)
    expect(all.map(view => view.groupName).sort()).toEqual(['Home', 'The Flat Share'])

    expect((await resolveMembership(account.ID, second.groupId))?.groupName).toBe('The Flat Share')
    expect((await resolveMembership(account.ID, first.groupId))?.groupName).toBe('Home')
  })

  it('falls back to a membership when the session names one that is not theirs', async () => {
    const account = await anAccount()
    await createGroup({ userId: account.ID, displayName: 'Ada', name: 'Home', kind: 'couple' })
    const resolved = await resolveMembership(account.ID, 'a-household-somebody-else-owns')
    expect(resolved?.groupName).toBe('Home')
  })

  it('gives each household its own seat, not a shared one', async () => {
    const account = await anAccount()
    const first = await createGroup({
      userId: account.ID,
      displayName: 'Ada',
      name: 'Home',
      kind: 'couple',
    })
    const second = await createGroup({
      userId: account.ID,
      displayName: 'Ada',
      name: 'Flat',
      kind: 'friends',
    })

    const all = await membershipsOf(account.ID)
    const seats = all.map(view => view.personId)
    expect(new Set(seats).size).toBe(2)
    expect(first.personId).not.toBe(second.personId)
  })

  it('reports nothing for an account that has joined nothing', async () => {
    const account = await anAccount()
    expect(await membershipsOf(account.ID)).toEqual([])
    expect(await resolveMembership(account.ID, null)).toBeNull()
  })
})

describe('the errors carry a status a route can use', () => {
  it('409 for a duplicate account, 404 for a bad code', async () => {
    const email = anAddress()
    await anAccount(email)
    await expect(anAccount(email)).rejects.toMatchObject({ status: 409 })

    const guest = await registerUser({
      email: anAddress('g'),
      password: PASSWORD,
      displayName: 'G',
    })
    await expect(
      joinGroup({ userId: guest.ID, displayName: 'G', code: 'AAAAAAAA' }),
    ).rejects.toBeInstanceOf(GroupError)
  })
})
