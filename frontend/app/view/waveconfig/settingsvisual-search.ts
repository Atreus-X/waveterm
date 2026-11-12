// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type SearchableField = { key: string; label: string; description?: string; tooltip: string };

// Every word of the query must appear somewhere in the field's key, label, description or tooltip, or in its
// section's title, so "terminal font" finds the terminal font settings and "transparent" finds opacity.
export function filterSections<S extends { title: string; fields: SearchableField[] }>(
    sections: S[],
    query: string
): S[] {
    const terms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term !== "");
    if (terms.length === 0) {
        return sections;
    }
    const result: S[] = [];
    for (const section of sections) {
        const fields = section.fields.filter((field) => {
            const haystack = [section.title, field.key, field.label, field.description ?? "", field.tooltip]
                .join(" ")
                .toLowerCase();
            return terms.every((term) => haystack.includes(term));
        });
        if (fields.length > 0) {
            result.push({ ...section, fields });
        }
    }
    return result;
}

export function countFields(sections: { fields: unknown[] }[]): number {
    return sections.reduce((total, section) => total + section.fields.length, 0);
}
