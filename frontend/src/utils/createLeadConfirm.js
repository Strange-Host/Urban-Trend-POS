// Creating a lead can come back "409 POSSIBLE_DUPLICATE_LEAD": an open lead with the same full name already exists.
// That is a question, not a refusal - the person may really be someone else - so ask, and if they say yes, send the
// same lead again with allow_possible_duplicate. (A matching phone or email is a plain 409 and just shows its message.)
// Returns the created lead, or null if they chose not to create it.
export async function createLeadWithConfirm({ create, payload, confirm }) {
  try {
    return await create(payload);
  } catch (err) {
    const data = err?.response?.data;
    if (err?.response?.status !== 409 || data?.error?.code !== 'POSSIBLE_DUPLICATE_LEAD') throw err;
    const names = (data.details?.possibleDuplicates || []).map((d) => d.name);
    const yes = await confirm({
      title: 'Possible duplicate lead',
      message: `A lead named "${names[0] || payload.name}" is already open${names.length > 1 ? ` (and ${names.length - 1} more like it)` : ''}. Is this a different person?`,
      confirmLabel: 'Yes, create it',
    });
    if (!yes) return null;
    return create({ ...payload, allow_possible_duplicate: true });
  }
}
