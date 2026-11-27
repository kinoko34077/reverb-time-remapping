# R4a IR時間周波数再合成core
T4 IR Spectral Remappingの有限カーネル生成。WetのSTFTと異なり、IRそのものをATFの複素STFT・瞬時周波数推定・peak-locked PVで再合成し、その結果を既存native convolutionへ渡す。既存のsource-timelineがIR age座標を所有し、synthがcarrier phaseを所有する。
- 入力は0原点のmono/stereo IR、参照開始frame、符号付き速度、有限出力frame数、zero/repeat境界。repeatは任意区間の分析中心を反復し、局所分析文脈は元IRから取得。pingpongは未受入の共通機構を先にpinせず後続。
- 通常1x/非反復はexact-rawで元IRを保持。0x/正負非単位速度は位相継続再合成。zero境界は有効中心の最終frame以降を0とし、出力長は有限。局所状態近似であって反射経路の分離/物理音場の固定ではない。逆ageは波形の厳密逆再生とは異なる。
- 既存STFT/PVのFFT・phase・左右保持を変更/再実装しない。再合成カーネルは振幅無正規化、signed predelayは畳み込み段。有限PCMと作業配列の推定予算を確認。無限IR・蓄積を許さない。
- R4a受入はcoreと実ブラウザnative畳み込みに限定。正規画面、第7モード、非同期計算/世代・連続編集・往復・補正・可視化・帯域/反射密度/周期性の広い音響測定はR4後続。同期coreを長尺でUIメインスレッドから直接呼ぶ設計は採用しない。
