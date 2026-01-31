# Gabo Flutter App

This folder contains a standalone Flutter implementation of the Gabo chat UI.
It is isolated from the existing static web assets so you can build and deploy
mobile apps without impacting the current site.

## Getting started

1. Install Flutter: https://docs.flutter.dev/get-started/install
2. From this directory, fetch dependencies:

```
flutter pub get
```

3. Run locally:

```
flutter run
```

## Firebase + Flutter: next steps

Use Firebase when you need authentication, database, file storage, or cloud
functions for the mobile experience. The fastest path is:

1. Create a Firebase project (Firebase Console).
2. Install the Firebase CLI and FlutterFire CLI.
3. Run `flutterfire configure` from this directory to generate
   `firebase_options.dart`.
4. Add the Firebase packages you need in `pubspec.yaml` (for example,
   `firebase_core`, `firebase_auth`, `cloud_firestore`).
5. Initialize Firebase in `main.dart` before `runApp`.

For step-by-step commands, see `firebase_setup.md`.

## Build for release

```
flutter build apk
flutter build ios
```

The app currently ships a starter UI shell that mirrors the web layout and is
ready for API wiring.
