# Whisper 长音频性能优化

补丁基于 whisper.cpp 的 `2eeeba56e9edd762b4b38467bab96c2517163158`。内存补丁在计算 mel 频谱时直接读取输入波形，只在边缘窗口计算反射和零填充。CLI 在单路识别、关闭静音检测且无需词级时间戳时，计算出 mel 特征后释放波形，再继续解码。

速度补丁移除了抽样路径里无效的候选词排序。启用 OpenMP 的构建会在解码时复用工作线程，其他构建继续使用标准库线程。

在装有 CUDA Toolkit 的 Visual Studio x64 开发者终端运行以下命令。`cmake` 和 `ninja` 需在 `PATH` 中。脚本使用这台 GTX 1660 上验证的构建参数，也可通过 `-CudaArchitecture` 指定目标架构。

```powershell
git clone https://github.com/ggml-org/whisper.cpp.git ../whisper-engine
git -C ../whisper-engine checkout --detach 2eeeba56e9edd762b4b38467bab96c2517163158
./scripts/build-whisper.ps1 -SourceDirectory ../whisper-engine -BuildDirectory ./dist/whisper-cuda
```

产物在构建目录的 `bin` 下。安装到拾音时，先等转写队列空闲，再把该目录里的 `whisper-cli.exe` 和同一次构建生成的 DLL 放入桌面版的 `bin/Release`。

在 GTX 1660 上用 Turbo Q5_0 和 8 个线程处理同一段 28 分 42 秒的音频，静音检测关闭。Windows 进程计数器记录的物理内存峰值由 690.78 MiB 降至 584.68 MiB，提交内存峰值由 1,956.26 MiB 降至 1,847.05 MiB。两次导出的 TXT、SRT 和 VTT 逐字节一致。

开启静音检测时，用同一份 90 秒音频做对照，三种输出也逐字节一致。该样本的提交内存峰值分别为 1,858.41 MiB 和 1,863.46 MiB。

速度补丁以上述内存优化版为基线。同一份 28 分 42 秒音频在相同模型、线程数和解码参数下，识别用时由 163.88 秒降至 143.22 秒，抽样阶段由 52.19 秒降至 30.94 秒。提交内存峰值由 1,848.35 MiB 降至 1,845.71 MiB。整段转写及开启静音检测的 90 秒样本均通过 TXT、SRT、VTT 的逐字节比对。
