import { useNavigation, useRoute } from "@react-navigation/native";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { api } from "../api";
import { isApiError } from "../api/errors";
import type { Approval, ApprovalDecisionResult, ApprovalStatus } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Header } from "../components/Header";
import { Banner, Card, Pill, PrimaryButton, row, text } from "../components/ui";
import { needsBiometric } from "../lib/approvals";
import { authenticate } from "../lib/biometric";
import { formatKes, timeAgo } from "../lib/format";
import { approvalTypeLabel } from "../lib/labels";
import { useSecureScreen } from "../lib/secureScreen";
import { MIN_TOUCH, colors, radius } from "../theme";

async function findApproval(token: string, id: string): Promise<Approval | null> {
  for (const status of ["pending", "approved", "rejected"] as ApprovalStatus[]) {
    const page = await api.approvals(token, status);
    const hit = page.items.find((a) => a.id === id);
    if (hit) return hit;
  }
  return null;
}

export default function ApprovalDetailScreen() {
  useSecureScreen();
  const nav = useNavigation<any>();
  const { params } = useRoute<any>() as { params: { id: string; approval?: Approval } };
  const { request, offline, approvalBiometricAboveCents } = useAuth();
  const [approval, setApproval] = useState<Approval | null>(params.approval ?? null);
  const [loading, setLoading] = useState(!params.approval);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (params.approval) return;
    request((t) => findApproval(t, params.id))
      .then((a) => {
        setApproval(a);
        if (!a) setMessage("This request no longer exists.");
      })
      .catch((e) => setMessage(isApiError(e) && e.code === "NETWORK" ? "Needs a connection to open this request." : "Could not load this request."))
      .finally(() => setLoading(false));
  }, [params.id, params.approval, request]);

  function finish(res: ApprovalDecisionResult) {
    if (res.applied) {
      nav.goBack();
      return;
    }
    // someone else decided first: show their decision and change nothing
    setApproval(res.approval);
    const a = res.approval;
    Alert.alert(
      "Already decided",
      `${a.status === "approved" ? "Approved" : "Rejected"} by ${a.decidedBy ?? "someone else"}${a.decidedAt ? ` ${timeAgo(a.decidedAt)}` : ""}. No change was made.`,
    );
  }

  async function run(fn: (t: string) => Promise<ApprovalDecisionResult>) {
    setBusy(true);
    setMessage(null);
    try {
      finish(await request(fn));
    } catch (e) {
      setMessage(isApiError(e) ? (e.code === "NETWORK" ? "No connection. Approvals need internet." : e.message) : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  function approve() {
    if (!approval) return;
    const label = `${approvalTypeLabel[approval.type]}${approval.amountCents ? ` of ${formatKes(approval.amountCents)}` : ""}`;
    const amount = approval.amountCents ?? 0;
    Alert.alert(`Approve ${label}?`, `Requested by ${approval.requestedBy}.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Approve",
        onPress: async () => {
          let confirmed = false;
          if (needsBiometric(amount, approvalBiometricAboveCents)) {
            const ok = await authenticate(`Confirm approval of ${formatKes(amount)}`);
            if (!ok) return;
            confirmed = true;
          }
          run((t) => api.approve(t, approval.id, confirmed));
        },
      },
    ]);
  }

  function submitReject() {
    if (!approval) return;
    const r = reason.trim();
    if (!r) return;
    setRejecting(false);
    setReason("");
    run((t) => api.reject(t, approval.id, r));
  }

  const pending = approval?.status === "pending";

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <Header
        eyebrow="Approval"
        title={approval ? approvalTypeLabel[approval.type] : "Approval"}
        onBack={() => nav.goBack()}
        right={approval && !pending ? <Pill text={approval.status === "approved" ? "Approved" : "Rejected"} /> : undefined}
      />
      {offline ? <Banner text="Offline · approving needs a connection." /> : null}
      {message ? <Banner text={message} /> : null}
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.ink} />
      ) : approval ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
          <Card>
            <Text style={s.amount}>{approval.amountCents ? formatKes(approval.amountCents) : "No amount"}</Text>
            <Text style={text.sub}>
              Requested by {approval.requestedBy} · {timeAgo(approval.requestedAt)}
            </Text>
          </Card>
          <Card>
            <Text style={text.title}>Reason</Text>
            <Text style={text.sub}>{approval.reason}</Text>
          </Card>
          {approval.items.length > 0 ? (
            <Card>
              <Text style={text.title}>Items</Text>
              {approval.items.map((it, i) => (
                <View key={i} style={[row.between, s.line]}>
                  <Text style={[s.itemName, { flexShrink: 1 }]}>
                    {it.qty} × {it.name}
                  </Text>
                  {it.priceCents ? <Text style={s.itemName}>{formatKes(it.priceCents * it.qty)}</Text> : null}
                </View>
              ))}
            </Card>
          ) : null}
          {!pending ? (
            <Card>
              <Text style={text.title}>
                {approval.status === "approved" ? "Approved" : "Rejected"} by {approval.decidedBy ?? "unknown"}
              </Text>
              {approval.decidedAt ? <Text style={text.sub}>{timeAgo(approval.decidedAt)}</Text> : null}
              {approval.decisionNote ? <Text style={text.sub}>{approval.decisionNote}</Text> : null}
            </Card>
          ) : (
            <View style={{ marginHorizontal: 16, marginTop: 6 }}>
              <PrimaryButton label="Approve" onPress={approve} loading={busy} disabled={offline} />
              <PrimaryButton label="Reject" variant="ghost" onPress={() => setRejecting(true)} disabled={busy || offline} />
            </View>
          )}
        </ScrollView>
      ) : null}

      <Modal visible={rejecting} transparent animationType="slide" onRequestClose={() => setRejecting(false)}>
        <View style={s.backdrop}>
          <View style={s.sheet}>
            <Text style={text.title}>Reason for rejecting</Text>
            <TextInput
              style={s.input}
              value={reason}
              onChangeText={setReason}
              placeholder="The requester will see this"
              multiline
              autoFocus
            />
            <PrimaryButton label="Reject" onPress={submitReject} disabled={!reason.trim()} />
            <PrimaryButton label="Cancel" variant="ghost" onPress={() => setRejecting(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  amount: { fontSize: 28, fontWeight: "700", color: colors.text },
  line: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.lineSoft },
  itemName: { fontSize: 14, color: colors.text },
  backdrop: { flex: 1, backgroundColor: "rgba(27,26,23,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.paper, padding: 20, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  input: {
    minHeight: MIN_TOUCH * 2,
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.button,
    backgroundColor: colors.surface,
    padding: 12,
    fontSize: 16,
    textAlignVertical: "top",
    color: colors.text,
  },
});
