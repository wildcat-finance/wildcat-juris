import { GoogleSpreadsheet } from 'google-spreadsheet';
import { AccountData } from './utils';

const HEADER_ROW = [
  'Market Name',
  'Market Address',
  'Borrower',
  'Network',
  'In Default?',
  'Time Delinquent (s)',
  'Grace Period (s)',
  'Penalized Days (signed)',
  'Total Owed (wei)',
  'Held (wei)',
  'Withdrawals (wei)',
  'Asset',
  'As-of Block',
  'Country',
  'Will speak to LEO?',
  'Will litigate?',
  'Name',
  'Email',
  'Other Contact Info',
  'Ethereum Address',
  'Signature',
];

const toRow = (a: AccountData): Array<string | number | boolean> => [
  a.marketName,
  a.market,
  a.borrower,
  a.network,
  a.inDefault,
  a.timeDelinquent,
  a.delinquencyGracePeriod,
  a.penalizedDays,
  a.amountOwedWei,
  a.heldOwedWei,
  a.withdrawalsOwedWei + (a.withdrawalsError ? ' (read incomplete)' : ''),
  a.assetSymbol,
  a.asOfBlock,
  a.country,
  a.willingToSpeakToLEO,
  a.willingToLitigate,
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

  /** Upsert keyed by (Ethereum Address, Market Address) — one row per lender per market. */
  async addAccount(account: AccountData): Promise<void> {
    if (!this.sheet) throw new Error('Sheets not connected — call connect() first');
    const rows = await this.sheet.getRows();
    const existing = rows.find(
      (r: any) =>
        (r['Ethereum Address'] ?? '').toLowerCase() === account.address.toLowerCase() &&
        (r['Market Address'] ?? '').toLowerCase() === account.market.toLowerCase()
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
