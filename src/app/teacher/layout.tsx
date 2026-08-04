import { Shell } from "@/components/Shell";

export default function TeacherLayout({ children }: { children: React.ReactNode }) {
  return <Shell role="TEACHER">{children}</Shell>;
}
