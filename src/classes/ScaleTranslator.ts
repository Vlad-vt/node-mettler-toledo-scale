/**
 * translates data from scale language to human readable
 * and vice versa
 */
export class ScaleTranslator {
  /**
   * translates from 00467 to js float
   * @param num string to be converted, e.g. 00467
   * @param precision decimal numbers count
   */
  static translateStringToFloat(num: string, precision: number): number {
    // Guard against empty/short input or a non-positive precision, which would
    // otherwise produce Number(".") === NaN and propagate a NaN weight/price.
    if (!num || precision <= 0) {
      const n = Number(num);
      return Number.isFinite(n) ? n : 0;
    }
    const sub1 = num.slice(0, num.length - precision) || '0';
    const sub2 = num.slice(num.length - precision);
    const result = Number(sub1 + '.' + sub2);
    return Number.isFinite(result) ? result : 0;
  }

  /**
   * oposite of translateStringToFloat
   * @param num input number
   * @param precision decimal numbers count
   * @param length total length of output string
   */
  static translateFloatToString(num: number, precision: number, length: number): string {
    let k = num.toString().split('.');
    if (k[1]) {
      k[1] = k[1].padEnd(precision, '0');
      k[0] = k[0].padStart(length - precision, '0');
      return k.join('');
    } else {
      // BUG FIX: previously this hardcoded '00' which produced wrong-length output
      // when precision != 2 (e.g. tare with precision=3 returned 3 chars instead of 4).
      // Now uses actual precision so output is always exactly `length` chars.
      k[1] = '0'.repeat(precision);
      k[0] = k[0].padStart(length - precision, '0');
      return k.join('');
    }
  }
}
