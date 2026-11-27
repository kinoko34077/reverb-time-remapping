# 共通音響・UI部品の固定版供給（R0）
正本は各既存リポジトリ。ここは手編集禁止の限定固定版供給であり、別実装・別技術正本ではない。Audio Lab の web-demo/vendor/frequency-warp-ui/manifest.json と shared-ui-snapshot.test.mjs の実績に沿い、必要な依存閉包と代表上流テストだけを原文のまま格納する。各 manifest の repository / commit / source / gitBlob が出典。更新はownerの変更後、同じ選択範囲・依存・固定版を再取得し、blob一致と上流/RTRテストをPRで確認する。現行ownerにない変更をこのディレクトリに直接加えない。
- atf: signed sample timeline, PCM renderer, STFT/PV, granular/WSOLA, AM（上流STFTテスト依存のみ）、bounded PCM cache。1/2ch、既存速度限界はこの供給版の能力でありRTR仕様の固定値ではない。
- fw: canonical units/binding, typed field, context menu, digit wheel, playback feedback。FW domain registryには時間/符号付き再生速度専用IDが未定義。既存wet等の意味が一致するもののみ直接利用し、新IDはownerで拡張を検討する。軸傾斜IDを偽装流用しない。
- 同一管理者の公開repoから、2026-11-27の明示された流用指示に基づき限定取り込み。選択ソースはJS/CSSの自作モジュールで外部package/音源を取り込まない。上流に明示ライセンスがないことを第三者への再許諾と解釈しない。圧縮codec vendor、WAV reader、Worklet bridge、波形Editor、Site Kit/Pages stagingの採用は個別接続時に依存・ライセンスを確定する。
- 元repoの変更/全consumer rolloutを受入条件にしない。prototype/ は非変更。R0は代表適合性の受入であり、正式8モードの動作/実機聴感を示さない。

検証: `node --test shared/atf/*.test.mjs shared/fw/*.test.mjs tests/*.test.mjs`。manifestのGit blob検査は同一ownerで採用済みの方式を適用。通常のPR Reviewでは固定commitの出典、依存closureと差分も照合する。
