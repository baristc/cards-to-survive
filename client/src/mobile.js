import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { StatusBar, Style } from "@capacitor/status-bar";

export async function initializeMobileApp() {
  if (!Capacitor.isNativePlatform()) return;

  await StatusBar.setOverlaysWebView({ overlay: false });
  await StatusBar.setBackgroundColor({ color: "#f7fbfd" });
  await StatusBar.setStyle({ style: Style.Light });

  await CapacitorApp.addListener("backButton", () => {
    CapacitorApp.minimizeApp();
  });
}
