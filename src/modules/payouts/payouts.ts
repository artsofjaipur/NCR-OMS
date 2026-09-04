import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { payoutBatches, settlementLines } from "../../db/schema";

/**
 * Creates a payout batch plus one settlement line per matched order, using
 * each order's own line-item total as that line's expected amount.
 */
export async function pullExpectedPayout(params: {
  marketplaceAccountId: number;
  expectedDate: Date;
  orderTotals: { orderId: number; expectedAmount: string }[];
}): Promise<{ payoutBatchId: number }> {
  return db.transaction(async (tx) => {
    const expectedAmount = params.orderTotals
      .reduce((sum, o) => sum + Number(o.expectedAmount), 0)
      .toFixed(2);

    const [batch] = await tx
      .insert(payoutBatches)
      .values({
        marketplaceAccountId: params.marketplaceAccountId,
        expectedDate: params.expectedDate,
        expectedAmount,
        status: "EXPECTED",
      })
      .returning({ id: payoutBatches.id });

    for (const order of params.orderTotals) {
      await tx.insert(settlementLines).values({
        payoutBatchId: batch.id,
        orderId: order.orderId,
        expectedAmount: order.expectedAmount,
      });
    }

    return { payoutBatchId: batch.id };
  });
}

/**
 * Confirmation is entered once per payout batch, not per order — the bank
 * credit lands as one lump sum. This distributes the received total
 * proportionally across the batch's settlement lines by each line's share
 * of expected amount, because P&L reads settlement at the *order* level,
 * not the batch level. Restricted to OWNER/ADMIN at the route layer.
 */
export async function confirmReceivedPayout(params: {
  payoutBatchId: number;
  receivedAmount: string;
  receivedDate: Date;
  bankReference: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const lines = await tx
      .select()
      .from(settlementLines)
      .where(eq(settlementLines.payoutBatchId, params.payoutBatchId));

    const totalExpected = lines.reduce((sum, l) => sum + Number(l.expectedAmount), 0);
    const totalReceived = Number(params.receivedAmount);

    let allocated = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const share = totalExpected > 0 ? Number(line.expectedAmount) / totalExpected : 0;
      // Give the last line whatever remains, so proportional rounding never
      // leaves a paise of the received total unallocated.
      const isLast = i === lines.length - 1;
      const paidAmount = isLast ? totalReceived - allocated : Math.round(totalReceived * share * 100) / 100;
      allocated += paidAmount;

      await tx
        .update(settlementLines)
        .set({
          paidAmount: paidAmount.toFixed(2),
          variance: (paidAmount - Number(line.expectedAmount)).toFixed(2),
        })
        .where(eq(settlementLines.id, line.id));
    }

    const status = Math.abs(totalReceived - totalExpected) < 0.01 ? "RECONCILED" : "PARTIALLY_RECEIVED";
    await tx
      .update(payoutBatches)
      .set({
        receivedAmount: params.receivedAmount,
        receivedDate: params.receivedDate,
        bankReference: params.bankReference,
        status,
      })
      .where(eq(payoutBatches.id, params.payoutBatchId));
  });
}
