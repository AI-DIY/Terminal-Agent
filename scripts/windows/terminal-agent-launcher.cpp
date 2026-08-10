#include <windows.h>
#include <shellapi.h>

#include <string>

namespace {

std::wstring QuoteWindowsArgument(const std::wstring& value) {
  if (value.empty()) return L"\"\"";
  if (value.find_first_of(L" \t\n\v\"") == std::wstring::npos) return value;

  std::wstring quoted = L"\"";
  size_t backslashes = 0;
  for (wchar_t character : value) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'\"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(character);
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, L'\\');
    backslashes = 0;
    quoted.push_back(character);
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'\"');
  return quoted;
}

std::wstring RuntimePath() {
  std::wstring current(MAX_PATH, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, current.data(), static_cast<DWORD>(current.size()));
  if (length == 0 || length == current.size()) return L"";
  current.resize(length);
  const size_t separator = current.find_last_of(L"\\/");
  if (separator == std::wstring::npos) return L"";
  return current.substr(0, separator + 1) + L"Terminal-Agent-runtime.exe";
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  const std::wstring runtime = RuntimePath();
  if (runtime.empty()) return 1;

  int argumentCount = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
  if (!arguments) return 1;

  std::wstring commandLine = QuoteWindowsArgument(runtime) + L" --";
  for (int index = 1; index < argumentCount; ++index) {
    commandLine += L" " + QuoteWindowsArgument(arguments[index]);
  }
  LocalFree(arguments);

  STARTUPINFOW startupInfo{};
  startupInfo.cb = sizeof(startupInfo);
  PROCESS_INFORMATION processInformation{};
  std::wstring mutableCommandLine = commandLine;
  const BOOL started = CreateProcessW(
    runtime.c_str(), mutableCommandLine.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr,
    &startupInfo, &processInformation);
  if (!started) return 1;

  CloseHandle(processInformation.hThread);
  CloseHandle(processInformation.hProcess);
  return 0;
}
