import SimpleLevel from './simple-level';
import { AccountData } from './utils';

/**
 * Claim store. Keyed by lowercased lender address; maintains an index of all
 * addresses that have submitted. Namespaced per network AND per incident, so
 * mainnet/testnet records and separate per-market incidents never collide.
 */
export class Database {
  private db: SimpleLevel;

  constructor(name = '.db') {
    this.db = new SimpleLevel(name);
  }

  private indexKey(network: string, incidentId: string): string {
    return `addresses:${network}:${incidentId}`;
  }

  private accountKey(network: string, incidentId: string, address: string): string {
    return `${network}:${incidentId}:${address.toLowerCase()}`;
  }

  async getAllAddresses(network: string, incidentId: string): Promise<string[]> {
    return (await this.db.get<string[]>(this.indexKey(network, incidentId))) ?? [];
  }

  async getAccount(
    network: string,
    incidentId: string,
    address: string
  ): Promise<AccountData | null> {
    return this.db.get<AccountData>(this.accountKey(network, incidentId, address));
  }

  async putAccount(account: AccountData): Promise<void> {
    const address = account.address.toLowerCase();
    await this.db.put(this.accountKey(account.network, account.incidentId, address), account as any);
    const all = await this.getAllAddresses(account.network, account.incidentId);
    if (!all.includes(address)) {
      all.push(address);
      await this.db.put(this.indexKey(account.network, account.incidentId), all);
    }
  }
}

export default new Database();
