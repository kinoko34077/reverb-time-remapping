# R4a IR時間周波数再合成core
T4 IR Spectral Remappingの有限カーネル生成。WetのSTFTと異なり、IRそのものをATFの複素STFT・瞬時周波数推定・peak-locked PVで再合成し、その結果を既存native convolutionへ渡す。既存のsource-timelineがIR age座標を所有し、synthがcarrier phaseを所有する。
- 入力は0原点のmono/stereo IR、参照開始frame、符号付き速度、有限出力frame数、zero/repeat境界。repeatは任意区間の分析中心を反復し、局所分析文脈は元IRから取得。pingpongは未受入の共通機構を先にpinせず後続。
- 通常1x/非反復はexact-rawで元IRを保持。0x/正負非単位速度は位相継続再合成。zero境界は有効中心の最終frame以降を0とし、出力長は有限。局所状態近似であって反射経路の分離/物理音場の固定ではない。逆ageは波形の厳密逆再生とは異なる。
- 既存STFT/PVのFFT・phase・左右保持を変更/再実装しない。再合成カーネルは振幅無正規化、signed predelayは畳み込み段。有限PCMと作業配列の推定予算を確認。無限IR・蓄積を許さない。
- R4a受入はcoreと実ブラウザnative畳み込みに限定。正規画面、第7モード、非同期計算/世代・連続編集・往復・補正・可視化・帯域/反射密度/周期性の広い音響測定はR4後続。同期coreを長尺でUIメインスレッドから直接呼ぶ設計は採用しない。

## R4b 第7モード・非同期有限IR更新
通常初期状態は基準Normalの厳密波形を共有。IR Spectral選択後に開始位置、正負速度/0、有限再合成長、zero/repeat範囲、FFT窓、自然/RMS補正を変更できる。IRは同一Workerへ世代ごとに一度cloneし、再合成PCMをtransfer。既存比較sessionの通常/逆方向/Dry/IR Window cacheを再利用し、最新要求queueと実render receipt後の既存crossfadeを共有する。要求値と適用済み軌道を別表示。変更失敗・旧世代・素材差替えは旧音/比較の保持を優先。Worker応答60秒は暫定の失敗検出で音響上限ではない。
共通時間範囲維持のため初期実装は再合成長を元IR長以内とする。長い再合成には共通範囲の再構成が必要。補正は生成IRと元IRのRMS比・共通上限で、出力安全gainとは独立。往復時の元IR分析文脈・全方式の広い音響測定・実機・寄与別の時変操作は別工程。
