# R2a 基準畳み込み実装

- T2の通常/逆方向をブラウザ標準 OfflineAudioContext / ConvolverNode（normalize=false）で計算。既存ATFのFFTは内部関数で、FWはRust/WASMの周波数変換用。新規FFT複製・不要な別repo改修を避け、標準畳み込みを利用する。チャンネル対応は明示mono処理で独立。負配置はPCMのoriginで表現する。
- FWの mixWet を固定版供給に追加し、共通座標へ整列したPCMの線形mixに利用。安全段は比較対象全体のピークから共通減衰を求め、線形測定値と分離。IR自動正規化なし。共通IR校正の選択UIは後続。
- 初期のprepared PCM予算64MiBは、長尺ファイルの未制限展開を避けるための保守的な推定枠で、端末能力や全メモリ使用量の保証ではない。実機測定による動的調整は後続。sample rate変換・progressive decode・UI/worker/transport接続はR2b以降。
- tests/convolution.test.mjsは経路・配置・予算の純粋試験。tests/browser/convolution.browser.test.mjsは実ブラウザのnative DSPをR1 oracleに照合。44.1/48/96kHz、短音/無音、左右経路、逆配置、1ms Delayのコム特性を検証。ヘッドレス試験は聴感/物理音声の証拠ではない。
- ブラウザ試験はAudio Lab既存のpuppeteer-core@24、Chrome、localhost、cleanupTestProcessesの経路を再利用。ランタイム依存・外部API・ユーザー音声の外部送信を追加しない。

R2aは基準DSP単位。正規entry、生成素材/IR、入力ファイル、A/B・再生・共通reader、可視化の受入は残る。R2全体の完了を意味しない。
