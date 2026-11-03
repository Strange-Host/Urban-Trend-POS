import React from "react";
import { View } from "react-native";
import { Header } from "../components/Header";
import { Card, text } from "../components/ui";
import { Text } from "react-native";
import { colors } from "../theme";

export default function PlaceholderScreen({ title, note }: { title: string; note: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <Header eyebrow="Urban Trends" title={title} />
      <Card>
        <Text style={text.title}>Not built yet</Text>
        <Text style={text.sub}>{note}</Text>
      </Card>
    </View>
  );
}
