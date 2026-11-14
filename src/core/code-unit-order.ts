// The one string order for anything that reaches evidence bytes: UTF-16 code
// units, which is what Array.prototype.sort() does with no comparator and what
// canonicalStringify sorts keys by.
//
// Never localeCompare there. With no locale it collates by the process's ICU
// default, so the same project orders differently on two machines: under
// da/nb/nn `aa` sorts after `z` (a lowercase-hex UUID moves), and in every
// locale `…-Report.xml` and `…-report.xml`, or `a-b`, `a_b`, `ab`, fall in
// another order than their code units. test/locale-free-evidence.test.ts keeps
// it out of src/core and src/main.
//
// No imports: core, main and the export worker all take it without the DB.

/** Code-unit order: a negative, zero or positive number, for Array.sort. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
