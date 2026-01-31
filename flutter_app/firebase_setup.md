# Firebase setup (Flutter)

Use this guide to wire Firebase into the Flutter app without affecting the
existing static site assets in the repo.

## 1) Create a Firebase project

- https://console.firebase.google.com
- Add Android and/or iOS apps in the project settings.

## 2) Install CLIs

```
# Firebase CLI
npm install -g firebase-tools

# FlutterFire CLI
dart pub global activate flutterfire_cli
```

## 3) Configure FlutterFire

From the `flutter_app` directory:

```
flutterfire configure
```

This generates `lib/firebase_options.dart` and updates the native platform
config files with your Firebase app IDs.

## 4) Add Firebase packages

Add the packages you need in `pubspec.yaml`, for example:

```
dependencies:
  firebase_core: ^2.31.0
  firebase_auth: ^4.19.0
  cloud_firestore: ^4.17.0
```

Then fetch dependencies:

```
flutter pub get
```

## 5) Initialize Firebase in `main.dart`

Add Firebase initialization before `runApp`:

```
import 'package:firebase_core/firebase_core.dart';
import 'firebase_options.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(
    options: DefaultFirebaseOptions.currentPlatform,
  );
  runApp(const GaboApp());
}
```

## 6) Build and run

```
flutter run
```

## Notes

- Use Firebase Auth for sign-in, Firestore for chat history, and Storage for
  attachments.
- Keep API keys and environment-specific values in Firebase config or a
  `.env` file (excluded from Git).
- Consider emulator usage for local testing:
  https://firebase.google.com/docs/emulator-suite
