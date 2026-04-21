// lib/signals/quarterly-calendar.ts — EjectSeat Consumer
// Determines fiscal quarter for any company, checks filing status

const USER_AGENT = 'EjectSeat/1.0 (enquiries.talkace@gmail.com)';
const EDGAR      = 'https://data.sec.gov';

export interface QuarterlyStatusResult {
  filingStatus:          'awaited' | 'filed' | 'overdue';
  currentQuarterLabel:   string;
  expectedFilingDate:    string;
  lastFiledDate?:        string;
  lastFiledForm?:        string;
  fiscalYearEnd:         string;
  signalAwaitedMessage?: string;
  daysUntilDue?:         number;
}

async function getFiscalYearEndMonth(cik: string): Promise<number> {
  try {
    const paddedCik = cik.replace(/^0+/, '').padStart(10, '0');
    const res = await fetch(`${EDGAR}/submissions/CIK${paddedCik}.json`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return 11;
    const data  = await res.json();
    const fyEnd = data.fiscalYearEnd;
    if (fyEnd) {
      const month = parseInt(fyEnd.slice(2, 4), 10) - 1;
      return month;
    }
    return 11;
  } catch { return 11; }
}

async function getRecentFilings(cik: string): Promise<{ form: string; date: string }[]> {
  try {
    const paddedCik = cik.replace(/^0+/, '').padStart(10, '0');
    const res = await fetch(`${EDGAR}/submissions/CIK${paddedCik}.json`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return [];
    const data   = await res.json();
    const recent = data.filings?.recent;
    if (!recent) return [];

    const forms = recent.form        || [];
    const dates = recent.filingDate  || [];
    const result: { form: string; date: string }[] = [];

    for (let i = 0; i < forms.length; i++) {
      // v6.1: include 20-F for FPI annual filings
      if (['10-K', '10-Q', '20-F'].includes(forms[i])) {
        result.push({ form: forms[i], date: dates[i] });
      }
    }
    return result.slice(0, 8);
  } catch { return []; }
}

function computeCurrentQuarter(fyEndMonth: number, today: Date): {
  quarterLabel: string;
  quarterEnd:   Date;
  filingDue:    Date;
  quarterNum:   number;
  fiscalYear:   number;
} {
  const quarters: { end: Date; num: number; fy: number }[] = [];

  for (let yearOffset = -1; yearOffset <= 1; yearOffset++) {
    const baseYear = today.getFullYear() + yearOffset;
    for (let q = 4; q >= 1; q--) {
      const endMonth = ((fyEndMonth - (4 - q) * 3) + 120) % 12;
      const endYear  = endMonth > fyEndMonth ? baseYear - 1 : baseYear;
      const lastDay  = new Date(endYear, endMonth + 1, 0);
      quarters.push({ end: lastDay, num: q, fy: q === 4 ? endYear : endYear + (fyEndMonth < endMonth ? 1 : 0) });
    }
  }

  quarters.sort((a, b) => b.end.getTime() - a.end.getTime());
  const currentQ = quarters.find(q => q.end <= today) || quarters[quarters.length - 1];

  const isAnnual   = currentQ.num === 4;
  const daysToFile = isAnnual ? 75 : 45;
  const filingDue  = new Date(currentQ.end);
  filingDue.setDate(filingDue.getDate() + daysToFile);

  const quarterMonthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const qEndMonth  = currentQ.end.getMonth();
  const qStartMonth = (qEndMonth - 2 + 12) % 12;
  const qStartYear  = qStartMonth > qEndMonth ? currentQ.end.getFullYear() - 1 : currentQ.end.getFullYear();
  const qEndYear    = currentQ.end.getFullYear();

  const quarterLabel = `Q${currentQ.num} FY${currentQ.fy} (${quarterMonthNames[qStartMonth]} ${qStartYear === qEndYear ? '' : qStartYear + '–'}${quarterMonthNames[qEndMonth]} ${qEndYear})`;

  return {
    quarterLabel,
    quarterEnd: currentQ.end,
    filingDue,
    quarterNum: currentQ.num,
    fiscalYear: currentQ.fy,
  };
}

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

export async function getQuarterlySignalStatus(cik: string): Promise<QuarterlyStatusResult> {
  const today = new Date();

  const [fyEndMonth, recentFilings] = await Promise.all([
    getFiscalYearEndMonth(cik),
    getRecentFilings(cik),
  ]);

  const fiscalYearEnd = MONTH_NAMES[fyEndMonth] + ' ' + new Date(2000, fyEndMonth + 1, 0).getDate();

  const { quarterLabel, quarterEnd, filingDue, quarterNum, fiscalYear } = computeCurrentQuarter(fyEndMonth, today);

  const lastFiling = recentFilings[0];
  const lastFiledDate = lastFiling?.date;
  const lastFiledForm = lastFiling?.form;

  const quarterFiled = lastFiledDate ? new Date(lastFiledDate) > quarterEnd : false;

  const daysUntilDue = Math.round((filingDue.getTime() - today.getTime()) / 86_400_000);
  const dueDateStr   = filingDue.toISOString().slice(0, 10);

  if (quarterFiled) {
    return {
      filingStatus:        'filed',
      currentQuarterLabel: quarterLabel,
      expectedFilingDate:  dueDateStr,
      lastFiledDate,
      lastFiledForm,
      fiscalYearEnd,
    };
  }

  const isOverdue = today > filingDue;
  const formExpected = quarterNum === 4 ? '10-K' : '10-Q';

  let signalAwaitedMessage: string;
  if (isOverdue) {
    signalAwaitedMessage = `${formExpected} for ${quarterLabel} was due ${dueDateStr} and has not yet been filed. Score may be stale — check SEC EDGAR for updates.`;
  } else if (daysUntilDue <= 14) {
    signalAwaitedMessage = `${formExpected} for ${quarterLabel} is due in ${daysUntilDue} days (${dueDateStr}). Score reflects prior quarter data until filed.`;
  } else {
    signalAwaitedMessage = `${formExpected} for ${quarterLabel} is due ${dueDateStr}. Score reflects most recent filed data${lastFiledDate ? ' (' + lastFiledForm + ' ' + lastFiledDate + ')' : ''}.`;
  }

  return {
    filingStatus:          isOverdue ? 'overdue' : 'awaited',
    currentQuarterLabel:   quarterLabel,
    expectedFilingDate:    dueDateStr,
    lastFiledDate,
    lastFiledForm,
    fiscalYearEnd,
    signalAwaitedMessage,
    daysUntilDue,
  };
}
