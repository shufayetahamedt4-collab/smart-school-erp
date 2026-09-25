package com.amareeschool.teachers;

import com.amareeschool.shell.NativeShellActivity;

/**
 * Amar E School — Teacher App.
 *
 * All of the shell's behaviour (fullscreen WebView, back handling, uploads,
 * camera, external-link escape, App Links, offline screen) lives in
 * {@link NativeShellActivity}; this class only states what makes the Teacher App
 * *this* app. See android/shell/ for the shared implementation.
 */
public class MainActivity extends NativeShellActivity {

  @Override
  protected String origin() {
    return BuildConfig.TEACHER_ORIGIN;
  }

  /**
   * Must match the check in the web app's install logic
   * (src/components/InstallApp.tsx → NATIVE_SHELL_UA). The suffix is what stops
   * the web app from telling a teacher to install the app they are already in.
   */
  @Override
  protected String uaSuffix() {
    return "AmarESchoolTeachers/1.0";
  }

  @Override
  protected String accentHex() {
    // Teachers App accent, matching src/lib/sectors.ts.
    return "0d9488";
  }

  @Override
  protected String errorTitle() {
    return "Can't reach your school right now";
  }
}
