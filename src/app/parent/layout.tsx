import { Shell } from "@/components/Shell";

export default function ParentLayout({ children }: { children: React.ReactNode }) {
  return <Shell role="GUARDIAN">{children}</Shell>;
}
