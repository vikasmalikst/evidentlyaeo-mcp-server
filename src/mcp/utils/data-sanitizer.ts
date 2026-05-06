/**
 * Data Sanitizer Utilities
 * Centralizes null annotation, empty array handling, and field projection
 * so tools never return bare nulls that cause LLM hallucinations.
 */

export interface AnnotatedNull {
  value: null;
  note: string;
}

export interface AnnotatedValue<T> {
  value: T;
  unit?: string;
  label?: string;
}

/**
 * Converts null/undefined numeric fields into an annotated object
 * so the LLM never sees a bare null and tries to infer a value.
 */
export function annotateNull(fieldLabel: string): AnnotatedNull {
  return {
    value: null,
    note: `No data collected for "${fieldLabel}" in this date range. Do not treat as 0 or estimate.`,
  };
}

/**
 * Wraps a numeric value with its unit and label for semantic clarity.
 */
export function annotateValue<T>(
  value: T,
  unit: string,
  label: string
): AnnotatedValue<T> {
  return { value, unit, label };
}

/**
 * Returns an annotated empty array result with a do-not-hallucinate instruction.
 */
export function annotateEmptyArray(entityName: string, context?: string): {
  items: [];
  empty: true;
  note: string;
} {
  return {
    items: [],
    empty: true,
    note:
      `No ${entityName} found${context ? ` for ${context}` : ''}. ` +
      `Do NOT invent or estimate ${entityName}. Report to the user that no data is available.`,
  };
}

/**
 * Projects only the requested fields from an object.
 * If fields array is empty or undefined, returns the full object.
 * Used to implement the universal ?fields= projection parameter.
 */
export function projectFields<T extends Record<string, unknown>>(
  obj: T,
  fields?: string[]
): Partial<T> {
  if (!fields || fields.length === 0) return obj;
  const result: Partial<T> = {};
  for (const key of fields) {
    if (key in obj) {
      result[key as keyof T] = obj[key as keyof T];
    }
  }
  return result;
}

/**
 * Safe division — returns annotateNull instead of Infinity or NaN.
 */
export function safeDivide(
  numerator: number,
  denominator: number,
  fieldLabel: string,
  multiplier = 1
): AnnotatedValue<number> | AnnotatedNull {
  if (!denominator || denominator === 0) {
    return annotateNull(fieldLabel);
  }
  return {
    value: parseFloat(((numerator / denominator) * multiplier).toFixed(2)),
    unit: multiplier === 100 ? 'percent_0_to_100' : 'ratio',
    label: fieldLabel,
  };
}
