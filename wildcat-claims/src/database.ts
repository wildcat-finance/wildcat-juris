import SimpleLevel from './simple-level';
import { AccountData } from './utils';

/**
 * Claim store. A claim is one lender against one market, so records are keyed by
 * network + market + lowercased lender address, with a per-(network, market) index
 * of submitting addresses. Mainnet/testnet and separate markets never collide.
 */
export class Database {
  private db: SimpleLevel;

  constructor(name = '.db') {
    this.db = new SimpleLevel(name);
  }

  private indexKey(network: string, market: string): string {
    return `addresses:${network}:${market.toLowerCase()}`;
  }

  private accountKey(network: string, market: string, address: string): string {
    return `${network}:${market.toLowerCase()}:${address.toLowerCase()}`;
  }

  async getAllAddresses(network: string, market: string): Promise<string[]> {
    return (await this.db.get<string[]>(this.indexKey(network, market))) ?? [];
  }

  async getAccount(network: string, market: string, address: string): Promise<AccountData | null> {
    return this.db.get<AccountData>(this.accountKey(network, market, address));
  }

  async putAccount(account: AccountData): Promise<void> {
    const address = account.address.toLowerCase();
    await this.db.put(this.accountKey(account.network, account.market, address), account as any);
    const all = await this.getAllAddresses(account.network, account.market);
    if (!all.includes(address)) {
      all.push(address);
      await this.db.put(this.indexKey(account.network, account.market), all);
    }
  }
}

export default new Database();
