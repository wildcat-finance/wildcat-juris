import { GoogleSpreadsheet } from 'google-spreadsheet';
import { AccountData } from './utils';

const HEADER_ROW = [
  'Incident',
  'Country',
  'State',
  'City',
  'Will speak to LEO?',
  'Will litigate?',
  'Network',
  'Eligibility Timestamp',
  'Snapshot Block',
  'Total Owed (wei)',
  '# Markets',
  'Market Addresses',
  'Borrowers',
  'Per-Market Owed',
  'Per-Market Held (wei)',
  'Per-Market Withdrawals (wei)',
  'Name',
  'Email',
  'Other Contact Info',
  'Ethereum Address',
  'Signature',
];

const fmtTimestamp = (ts: number): string =>
  ts > 0 ? new Date(ts * 1000).toISOString() : 'latest';

const toRow = (a: AccountData): Array<string | number | boolean> => [
  a.incidentId,
  a.country,
  a.state,
  a.city,
  a.willingToSpeakToLEO,
  a.willingToLitigate,
  a.network,
  fmtTimestamp(a.eligibilityTimestamp),
  a.blockNumber,
  a.totalAmountOwedWei,
  a.claims.length,
  a.claims.map((c) => c.market).join('\n'),
  a.claims.map((c) => c.borrower).join('\n'),
  a.claims.map((c) => `${c.amountOwed} ${c.assetSymbol}`).join('\n'),
  a.claims.map((c) => c.heldOwedWei).join('\n'),
  a.claims.map((c) => c.withdrawalsOwedWei).join('\n'),
  a.name,
  a.email,
  a.other,
  a.address,
  a.signature,
];

/**
 * Google Sheets mirror of submitted claims. No work happens at import time;
 * `connect()` must be called explicitly during startup.
 */
export class Sheets {
  private doc: any;
  private sheet?: any;

  constructor(
    private sheetId: string,
    private clientEmail: string,
    private privateKey: string
  ) {
    this.doc = new GoogleSpreadsheet(this.sheetId);
  }

  async connect(): Promise<void> {
    await this.doc.useServiceAccountAuth({
      client_email: this.clientEmail,
      private_key: this.privateKey,
    });
    await this.doc.loadInfo();
    this.sheet = this.doc.sheetsByIndex[0];
    await this.sheet.loadHeaderRow().catch(() => undefined);
    if (!this.sheet.headerValues || this.sheet.headerValues.length !== HEADER_ROW.length) {
      await this.sheet.setHeaderRow(HEADER_ROW);
    }
  }

  async addAccount(account: AccountData): Promise<void> {
    if (!this.sheet) throw new Error('Sheets not connected — call connect() first');
    const rows = await this.sheet.getRows();
    const existing = rows.find(
      (r: any) => (r['Ethereum Address'] ?? '').toLowerCase() === account.address.toLowerCase()
    );
    const values = toRow(account);
    if (existing) {
      HEADER_ROW.forEach((key, i) => {
        existing[key] = values[i] as any;
      });
      await existing.save();
    } else {
      await this.sheet.addRow(values);
    }
  }
}
